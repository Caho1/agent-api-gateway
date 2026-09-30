import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  GatewayError,
  object,
  parseService,
  validName,
  type Config,
  type Service,
} from "./model.ts";
export function privateWrite(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export class Settings {
  private keys: Record<string, string> = Object.create(null);
  readonly config: Config;
  private configPath: string;
  private secretsPath: string;
  private fallbackKey: string;
  constructor(
    config: Config,
    configPath: string,
    secretsPath: string,
    fallbackKey = "",
  ) {
    this.config = config;
    this.configPath = configPath;
    this.secretsPath = secretsPath;
    this.fallbackKey = fallbackKey;
    try {
      const value: unknown = JSON.parse(readFileSync(secretsPath, "utf8"));
      if (
        !object(value) ||
        !Object.entries(value).every(
          ([k, v]) =>
            validName(k) &&
            typeof v === "string" &&
            v.length <= 4096 &&
            !/[\r\n]/.test(v),
        )
      )
        throw new Error("Invalid credentials");
      this.keys = Object.assign(Object.create(null), value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private binding(id: string, service: Service) {
    return (
      "v2." +
      createHash("sha256")
        .update(
          JSON.stringify([
            id,
            new URL(service.origin).origin,
            service.credential.type,
            service.credential.type === "none"
              ? ""
              : service.credential.type === "header"
                ? service.credential.name.toLowerCase()
                : service.credential.name,
            service.credential.type === "none"
              ? ""
              : (service.credential.prefix ?? ""),
          ]),
        )
        .digest("base64url")
    );
  }
  key(id: string) {
    const service = Object.hasOwn(this.config.services, id)
      ? this.config.services[id]
      : undefined;
    return service ? (this.keys[this.binding(id, service)] ?? "") : "";
  }
  redact(value: unknown): unknown {
    if (typeof value === "string") {
      for (const key of [...Object.values(this.keys), this.fallbackKey])
        if (key) value = (value as string).split(key).join("[REDACTED]");
      return value;
    }
    if (Array.isArray(value)) return value.map((x) => this.redact(x));
    if (object(value))
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.redact(v)]),
      );
    return value;
  }
  connections() {
    return Object.entries(this.config.services).map(([id, service]) => ({
      id,
      ...service,
      credentialConfigured:
        service.credential.type === "none" || Boolean(this.key(id)),
    }));
  }
  saveConnection(raw: unknown, convertLegacy = false) {
    if (
      !object(raw) ||
      !validName(raw.id) ||
      (raw.apiKey !== undefined &&
        (typeof raw.apiKey !== "string" ||
          raw.apiKey.length < 8 ||
          raw.apiKey.length > 4096 ||
          /[^\x20-\x7e]/.test(raw.apiKey)))
    )
      throw new GatewayError(400, "invalid_connection");
    const { id, apiKey, ...definition } = raw;
    const previous = Object.hasOwn(this.config.services, id)
      ? this.config.services[id]
      : undefined;
    if (previous?.access === "routes" && !convertLegacy) {
      if (definition.access === "service")
        throw new GatewayError(409, "explicit_migration_required");
      // Normal key/origin edits preserve old restrictions, even when a simplified client omits them.
      definition.access = "routes";
      definition.routes = previous.routes ?? [];
    }
    let service;
    try {
      service = parseService(definition);
    } catch {
      throw new GatewayError(400, "invalid_connection");
    }
    if (
      !Object.hasOwn(this.config.services, id) &&
      Object.keys(this.config.services).length >= 100
    )
      throw new GatewayError(400, "connection_limit");
    const services = Object.assign(Object.create(null), this.config.services, {
      [id]: service,
    });
    const next = { ...this.config, services };
    if (apiKey !== undefined) {
      const keys = Object.assign(Object.create(null), this.keys, {
        [this.binding(id, service)]: apiKey,
      });
      privateWrite(this.secretsPath, JSON.stringify(keys));
      this.keys = keys;
    }
    privateWrite(this.configPath, JSON.stringify(next, null, 2));
    this.config.services = services;
    return id;
  }
  upgradeConnection(id: string) {
    const previous = Object.hasOwn(this.config.services, id)
      ? this.config.services[id]
      : undefined;
    if (!previous || previous.access !== "routes")
      throw new GatewayError(409, "migration_not_required");
    const definition: Record<string, unknown> = {
      ...previous,
      access: "service",
    };
    delete definition.routes;
    return this.saveConnection({ id, ...definition }, true);
  }
  deleteConnection(id: string) {
    if (!validName(id) || !Object.hasOwn(this.config.services, id))
      throw new GatewayError(404, "connection_not_found");
    const services = Object.assign(Object.create(null), this.config.services);
    delete services[id];
    privateWrite(
      this.configPath,
      JSON.stringify({ ...this.config, services }, null, 2),
    );
    this.config.services = services;
    // Historical credential bindings and legacy keys remain private for consistent rollback.
    // They are unreachable unless config explicitly selects that exact service/origin/injection.
  }

  setGlobal(raw: unknown) {
    if (
      !object(raw) ||
      Object.keys(raw).length !== 1 ||
      !Number.isSafeInteger(raw.globalDailyUnits) ||
      Number(raw.globalDailyUnits) < 1 ||
      Number(raw.globalDailyUnits) > 1000000
    )
      throw new GatewayError(400, "invalid_quota");
    const next = {
      ...this.config,
      globalDailyUnits: Number(raw.globalDailyUnits),
    };
    privateWrite(this.configPath, JSON.stringify(next, null, 2));
    this.config.globalDailyUnits = next.globalDailyUnits;
  }
}
