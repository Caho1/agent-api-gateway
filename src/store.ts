import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  GatewayError,
  validName,
  object,
  type Invocation,
  type Route,
} from "./model.ts";
import { canonicalPath, validRoutes, routeAllows } from "./path-policy.ts";
export type Grant = {
  schemaVersion: 2 | 3;
  id: string;
  services: string[];
  routes?: Route[];
  expiresAt: number;
  dailyUnits: number;
  totalUnits: number;
  perMinute: number;
};
export function validGrant(value: unknown): value is Grant {
  return (
    object(value) &&
    (value.schemaVersion === 2 || value.schemaVersion === 3) &&
    Object.keys(value).every((k) =>
      [
        "schemaVersion",
        "id",
        "services",
        "routes",
        "expiresAt",
        "dailyUnits",
        "totalUnits",
        "perMinute",
      ].includes(k),
    ) &&
    validName(value.id) &&
    Array.isArray(value.services) &&
    value.services.length > 0 &&
    value.services.length <= 100 &&
    value.services.every(validName) &&
    new Set(value.services).size === value.services.length &&
    (value.schemaVersion === 2
      ? validRoutes(value.routes)
      : !Object.hasOwn(value, "routes")) &&
    Number.isSafeInteger(value.expiresAt) &&
    Number(value.expiresAt) > 0 &&
    [value.dailyUnits, value.totalUnits, value.perMinute].every(
      (x) => Number.isSafeInteger(x) && Number(x) > 0,
    ) &&
    Number(value.dailyUnits) <= 1000000 &&
    Number(value.totalUnits) <= 1000000000 &&
    Number(value.perMinute) <= 10000
  );
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, policy TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS daily (subject TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(subject,day));
      CREATE TABLE IF NOT EXISTS audit (request_id TEXT PRIMARY KEY, time INTEGER NOT NULL, grant_id TEXT NOT NULL, operation TEXT NOT NULL, account TEXT NOT NULL, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_rate (grant_id TEXT PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_audit (request_id TEXT PRIMARY KEY, path TEXT NOT NULL, upstream_status INTEGER);`);
  }
  create(grant: Grant, token = randomBytes(32).toString("base64url")) {
    if (
      !validGrant(grant) ||
      grant.expiresAt <= Date.now() ||
      !/^[a-zA-Z0-9_-]{43,128}$/.test(token)
    )
      throw new Error("Invalid grant");
    this.db
      .prepare("INSERT INTO grants(id,token_hash,policy) VALUES (?,?,?)")
      .run(grant.id, hash(token), JSON.stringify(grant));
    return token;
  }
  revoke(id: string) {
    return (
      this.db.prepare("UPDATE grants SET revoked=1 WHERE id=?").run(id)
        .changes > 0
    );
  }
  revokeService(id: string) {
    // Revoke before editing/deleting origin or key: old tokens never inherit new service authority.
    for (const row of this.db
      .prepare("SELECT id,policy FROM grants WHERE revoked=0")
      .all()) {
      let policy: unknown;
      try {
        policy = JSON.parse(String(row.policy));
      } catch {
        this.revoke(String(row.id));
        continue;
      }
      if (!validGrant(policy) || policy.services.includes(id))
        this.revoke(String(row.id));
    }
  }
  summary(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const grants = this.db
      .prepare("SELECT id,policy,revoked,used FROM grants ORDER BY id")
      .all()
      .map((row) => {
        let value: unknown;
        try {
          value = JSON.parse(String(row.policy));
        } catch {
          value = {};
        }
        const valid = validGrant(value) && value.id === row.id;
        const grant: Grant = valid
          ? (value as Grant)
          : {
              schemaVersion: 2,
              id: String(row.id),
              services: [],
              routes: [],
              expiresAt:
                object(value) && Number.isSafeInteger(value.expiresAt)
                  ? Number(value.expiresAt)
                  : 0,
              dailyUnits:
                object(value) && Number.isSafeInteger(value.dailyUnits)
                  ? Number(value.dailyUnits)
                  : 0,
              totalUnits:
                object(value) && Number.isSafeInteger(value.totalUnits)
                  ? Number(value.totalUnits)
                  : 0,
              perMinute: 0,
            };
        const dailyUsed = Number(
          this.db
            .prepare("SELECT used FROM daily WHERE subject=? AND day=?")
            .get("grant:" + grant.id, day)?.used ?? 0,
        );
        return {
          ...grant,
          revoked: Boolean(row.revoked),
          used: Number(row.used),
          dailyUsed,
          legacy: !valid,
          restricted: valid && grant.schemaVersion === 2,
          status: row.revoked
            ? "revoked"
            : !valid
              ? "migration_required"
              : grant.expiresAt <= now
                ? "expired"
                : "active",
        };
      });
    return {
      day,
      globalUsed: Number(
        this.db
          .prepare("SELECT used FROM daily WHERE subject='global' AND day=?")
          .get(day)?.used ?? 0,
      ),
      grants,
    };
  }
  audit(limit = 100) {
    return this.db
      .prepare(
        "SELECT a.request_id,a.time,a.grant_id,a.operation AS method,a.account AS service,a.outcome,r.path,r.upstream_status FROM audit a LEFT JOIN relay_audit r USING(request_id) ORDER BY a.time DESC LIMIT ?",
      )
      .all(Math.min(200, Math.max(1, limit)));
  }
  reserve(
    token: string,
    input: Pick<Invocation, "service" | "method" | "path">,
    globalLimit: number,
    requestId: string,
    now = Date.now(),
  ): string {
    if (!/^[a-zA-Z0-9_-]{43,128}$/.test(token))
      throw new GatewayError(401, "unauthorized");
    const path = canonicalPath(input.path);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM grants WHERE token_hash=?")
        .get(hash(token));
      if (!row || row.revoked || !row.policy)
        throw new GatewayError(401, "unauthorized");
      let grant: unknown;
      try {
        grant = JSON.parse(String(row.policy));
      } catch {
        throw new GatewayError(401, "unauthorized");
      }
      if (!validGrant(grant) || row.id !== grant.id)
        throw new GatewayError(401, "unauthorized");
      if (
        !Number.isSafeInteger(row.used) ||
        Number(row.used) < 0 ||
        !Number.isSafeInteger(globalLimit) ||
        globalLimit < 1
      )
        throw new GatewayError(503, "service_unavailable");
      if (grant.expiresAt <= now) throw new GatewayError(401, "unauthorized");
      if (
        !grant.services.includes(input.service) ||
        (grant.schemaVersion === 2 &&
          !routeAllows(grant.routes ?? [], input.method, path))
      )
        throw new GatewayError(403, "forbidden");
      if (Number(row.used) >= grant.totalUnits)
        throw new GatewayError(429, "quota_exceeded");
      const minute = Math.floor(now / 60000),
        rate = this.db
          .prepare("SELECT window,used FROM relay_rate WHERE grant_id=?")
          .get(grant.id);
      if (
        rate &&
        (!Number.isSafeInteger(rate.used) ||
          Number(rate.used) < 0 ||
          !Number.isSafeInteger(rate.window))
      )
        throw new GatewayError(503, "service_unavailable");
      if (
        rate &&
        Number(rate.window) === minute &&
        Number(rate.used) >= grant.perMinute
      )
        throw new GatewayError(429, "rate_exceeded");
      const day = new Date(now).toISOString().slice(0, 10);
      for (const [subject, limit] of [
        ["grant:" + grant.id, grant.dailyUnits],
        ["global", globalLimit],
      ] as const) {
        const used = Number(
          this.db
            .prepare("SELECT used FROM daily WHERE subject=? AND day=?")
            .get(subject, day)?.used ?? 0,
        );
        if (!Number.isSafeInteger(used) || used < 0)
          throw new GatewayError(503, "service_unavailable");
        if (used >= limit) throw new GatewayError(429, "quota_exceeded");
        this.db
          .prepare(
            "INSERT INTO daily(subject,day,used) VALUES (?,?,1) ON CONFLICT(subject,day) DO UPDATE SET used=used+1",
          )
          .run(subject, day);
      }
      this.db
        .prepare(
          "INSERT INTO relay_rate(grant_id,window,used) VALUES (?,?,1) ON CONFLICT(grant_id) DO UPDATE SET used=CASE WHEN window=excluded.window THEN used+1 ELSE 1 END,window=excluded.window",
        )
        .run(grant.id, minute);
      this.db.prepare("UPDATE grants SET used=used+1 WHERE id=?").run(grant.id);
      this.db
        .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
        .run(requestId, now, grant.id, input.method, input.service, "reserved");
      this.db
        .prepare("INSERT INTO relay_audit(request_id,path) VALUES(?,?)")
        .run(requestId, path);
      this.db.exec("COMMIT");
      return grant.id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finish(requestId: string, success: boolean, status?: number) {
    this.db
      .prepare("UPDATE audit SET outcome=? WHERE request_id=?")
      .run(success ? "succeeded" : "failed", requestId);
    if (status !== undefined)
      this.db
        .prepare("UPDATE relay_audit SET upstream_status=? WHERE request_id=?")
        .run(status, requestId);
  }
  close() {
    this.db.close();
  }
}
