import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminAuth } from "./admin-auth.ts";
import { GatewayError, object, validName } from "./model.ts";
import { validGrant, type Store } from "./store.ts";
import type { Settings } from "./settings.ts";
import type { AdapterRegistry } from "./registry.ts";
const assets = new Map([
  ["/admin", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin/", ["admin.html", "text/html; charset=utf-8"]],
  ["/admin/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/admin/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
export class Admin {
  readonly origin: string;
  private secure: boolean;
  readonly auth: AdminAuth;
  private settings: Settings;
  private store: Store;
  private registry: AdapterRegistry;
  constructor(
    auth: AdminAuth,
    settings: Settings,
    store: Store,
    registry: AdapterRegistry,
    origin = "http://127.0.0.1:8787",
  ) {
    this.auth = auth;
    this.settings = settings;
    this.store = store;
    this.registry = registry;
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error("Admin requires HTTPS or a loopback origin");
    this.origin = origin;
    this.secure = url.protocol === "https:";
    this.store.db.exec(
      "CREATE TABLE IF NOT EXISTS admin_audit (id TEXT PRIMARY KEY, time INTEGER NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL)",
    );
  }
  private log(action: string, subject: string) {
    this.store.db
      .prepare(
        "INSERT INTO admin_audit VALUES(lower(hex(randomblob(16))),?,?,?)",
      )
      .run(Date.now(), action, subject);
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    readBody: (req: IncomingMessage) => Promise<unknown>,
  ): Promise<boolean> {
    if (!req.url?.startsWith("/admin")) return false;
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "cross-origin-resource-policy": "same-origin",
    };
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(this.settings.redact(data)));
    };
    if (req.headers.origin && req.headers.origin !== this.origin)
      throw new GatewayError(403, "invalid_origin");
    if (req.method === "GET" && assets.has(req.url)) {
      const [file, type] = assets.get(req.url)!;
      res.writeHead(200, { "content-type": type! });
      res.end(readFileSync(new URL("../web/" + file, import.meta.url)));
      return true;
    }
    if (!req.url.startsWith("/admin/api/"))
      throw new GatewayError(404, "not_found");
    const mutation = req.method !== "GET";
    if (mutation && req.headers.origin !== this.origin)
      throw new GatewayError(403, "invalid_origin");
    if (req.url === "/admin/api/status" && req.method === "GET") {
      send(200, { configured: this.auth.configured });
      return true;
    }
    if (req.url === "/admin/api/login" && req.method === "POST") {
      const body = await readBody(req);
      if (
        !object(body) ||
        Object.keys(body).length !== 1 ||
        !Object.hasOwn(body, "password")
      )
        throw new GatewayError(400, "invalid_request");
      const session = await this.auth.login(body.password);
      try {
        this.auth.logout(this.auth.session(req.headers.cookie).token);
      } catch {
        /* no prior valid session */
      }
      res.setHeader(
        "set-cookie",
        `gateway_admin=${session.token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=1800${this.secure ? "; Secure" : ""}`,
      );
      send(200, { csrf: session.csrf, expiresAt: session.expiresAt });
      return true;
    }
    const session = this.auth.session(req.headers.cookie);
    if (mutation) {
      const csrf = req.headers["x-csrf-token"];
      if (
        typeof csrf !== "string" ||
        !/^[a-zA-Z0-9_-]{43}$/.test(csrf) ||
        csrf.length !== session.csrf.length ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
      )
        throw new GatewayError(403, "invalid_csrf");
    }
    if (req.url === "/admin/api/state" && req.method === "GET") {
      send(200, {
        csrf: session.csrf,
        expiresAt: session.expiresAt,
        connections: this.settings.connections(),
        providers: this.registry.catalog(),
        ...this.store.summary(),
        globalDailyUnits: this.settings.config.globalDailyUnits,
        audit: this.store.audit(),
        adminAudit: this.store.db
          .prepare(
            "SELECT time,action,subject FROM admin_audit ORDER BY time DESC LIMIT 100",
          )
          .all(),
      });
    } else if (req.url === "/admin/api/logout" && req.method === "POST") {
      this.auth.logout(session.token);
      res.setHeader(
        "set-cookie",
        `gateway_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? "; Secure" : ""}`,
      );
      send(200, { ok: true });
    } else if (req.url === "/admin/api/connections" && req.method === "POST") {
      const id = this.settings.saveConnection(await readBody(req));
      this.log("connection_saved", id);
      send(200, { ok: true });
    } else if (
      req.url === "/admin/api/connections/delete" &&
      req.method === "POST"
    ) {
      const raw = await readBody(req);
      if (!object(raw) || Object.keys(raw).length !== 1 || !validName(raw.id))
        throw new GatewayError(400, "invalid_request");
      for (const grant of this.store.summary().grants) {
        if (grant.accounts.includes(raw.id)) this.store.revoke(grant.id);
      }
      this.settings.deleteConnection(raw.id);
      this.log("connection_deleted", raw.id);
      send(200, { ok: true });
    } else if (req.url === "/admin/api/quota" && req.method === "POST") {
      this.settings.setGlobal(await readBody(req));
      this.log("quota_updated", "global");
      send(200, { ok: true });
    } else if (req.url === "/admin/api/grants" && req.method === "POST") {
      const grant = await readBody(req);
      if (
        !validGrant(grant) ||
        Object.keys(grant).some(
          (k) =>
            ![
              "id",
              "accounts",
              "operations",
              "expiresAt",
              "dailyUnits",
              "totalUnits",
            ].includes(k),
        ) ||
        new Set(grant.accounts).size !== grant.accounts.length ||
        new Set(grant.operations).size !== grant.operations.length ||
        grant.accounts.length > 100 ||
        grant.operations.length > 100 ||
        grant.expiresAt <= Date.now() ||
        grant.expiresAt > Date.now() + 365 * 86_400_000 ||
        grant.dailyUnits > 1_000_000 ||
        grant.totalUnits > 1_000_000_000
      )
        throw new GatewayError(400, "invalid_grant");
      for (const id of grant.accounts) {
        const account = Object.hasOwn(this.settings.config.accounts, id)
          ? this.settings.config.accounts[id]
          : undefined;
        const adapter = this.registry
          .catalog()
          .find((x) => x.id === account?.provider);
        if (
          !account ||
          !adapter ||
          !grant.operations.every((x) => adapter.operations.includes(x))
        )
          throw new GatewayError(400, "invalid_scope");
      }
      if (
        this.store.db.prepare("SELECT id FROM grants WHERE id=?").get(grant.id)
      )
        throw new GatewayError(409, "grant_exists");
      if (
        Number(
          this.store.db.prepare("SELECT count(*) AS n FROM grants").get()!.n,
        ) >= 1000
      )
        throw new GatewayError(400, "grant_limit");
      let token: string;
      try {
        token = this.store.create(grant);
      } catch (error) {
        if (
          this.store.db
            .prepare("SELECT id FROM grants WHERE id=?")
            .get(grant.id)
        )
          throw new GatewayError(409, "grant_exists");
        throw error;
      }
      this.log("grant_created", grant.id);
      send(201, { id: grant.id, token });
    } else if (
      req.url === "/admin/api/grants/revoke" &&
      req.method === "POST"
    ) {
      const raw = await readBody(req);
      if (!object(raw) || Object.keys(raw).length !== 1 || !validName(raw.id))
        throw new GatewayError(400, "invalid_request");
      if (!this.store.revoke(raw.id))
        throw new GatewayError(404, "grant_not_found");
      this.log("grant_revoked", raw.id);
      send(200, { ok: true });
    } else throw new GatewayError(404, "not_found");
    return true;
  }
}
