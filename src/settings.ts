import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  GatewayError,
  object,
  parseConfig,
  validName,
  type Config,
} from "./model.ts";
import type { AdapterRegistry } from "./registry.ts";
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
  private registry: AdapterRegistry;
  private fallbackKey: string;
  constructor(
    config: Config,
    configPath: string,
    secretsPath: string,
    registry: AdapterRegistry,
    fallbackKey = "",
  ) {
    this.config = config;
    this.configPath = configPath;
    this.secretsPath = secretsPath;
    this.registry = registry;
    this.fallbackKey = fallbackKey;
    try {
      const value: unknown = JSON.parse(readFileSync(secretsPath, "utf8"));
      if (
        !object(value) ||
        !Object.entries(value).every(
          ([k, v]) => validName(k) && typeof v === "string" && v.length <= 4096,
        )
      )
        throw new Error("Invalid credentials");
      this.keys = Object.assign(Object.create(null), value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  key(id: string) {
    return this.keys[id] ?? this.fallbackKey;
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
    return Object.entries(this.config.accounts).map(([id, account]) => ({
      id,
      ...account,
      credentialConfigured: Boolean(this.key(id)),
    }));
  }
  saveConnection(raw: unknown) {
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (k) => !["id", "provider", "secUid", "postIds", "apiKey"].includes(k),
      ) ||
      !validName(raw.id) ||
      raw.provider !== "tikhub" ||
      typeof raw.secUid !== "string" ||
      !Array.isArray(raw.postIds) ||
      raw.postIds.length > 500 ||
      (raw.apiKey !== undefined &&
        (typeof raw.apiKey !== "string" ||
          raw.apiKey.length < 8 ||
          raw.apiKey.length > 4096 ||
          /[\r\n]/.test(raw.apiKey)))
    )
      throw new GatewayError(400, "invalid_connection");
    const id = raw.id;
    if (
      !Object.hasOwn(this.config.accounts, id) &&
      Object.keys(this.config.accounts).length >= 100
    )
      throw new GatewayError(400, "connection_limit");
    const accounts = Object.assign(Object.create(null), this.config.accounts, {
      [id]: {
        provider: "tikhub",
        settings: { secUid: raw.secUid, postIds: raw.postIds },
      },
    });
    const next = parseConfig({
      accounts,
      globalDailyUnits: this.config.globalDailyUnits,
    });
    this.registry.validateConfig(next);
    if (raw.apiKey !== undefined) {
      const keys = Object.assign(Object.create(null), this.keys, {
        [id]: raw.apiKey,
      });
      privateWrite(this.secretsPath, JSON.stringify(keys));
      this.keys = keys;
    }
    privateWrite(this.configPath, JSON.stringify(next, null, 2));
    this.config.accounts = next.accounts;
    return id;
  }
  deleteConnection(id: string) {
    if (!validName(id) || !Object.hasOwn(this.config.accounts, id))
      throw new GatewayError(404, "connection_not_found");
    const accounts = Object.assign(Object.create(null), this.config.accounts);
    delete accounts[id];
    const next = { ...this.config, accounts };
    privateWrite(this.configPath, JSON.stringify(next, null, 2));
    this.config.accounts = accounts;
    const keys = Object.assign(Object.create(null), this.keys);
    delete keys[id];
    privateWrite(this.secretsPath, JSON.stringify(keys));
    this.keys = keys;
  }
  setGlobal(raw: unknown) {
    if (
      !object(raw) ||
      Object.keys(raw).length !== 1 ||
      !Number.isSafeInteger(raw.globalDailyUnits) ||
      Number(raw.globalDailyUnits) < 1 ||
      Number(raw.globalDailyUnits) > 1_000_000
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
