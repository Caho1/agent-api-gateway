import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { GatewayError, validName, object, type Operation } from "./model.ts";
export type Grant = {
  id: string;
  accounts: string[];
  operations: Operation[];
  expiresAt: number;
  dailyUnits: number;
  totalUnits: number;
};
export function validGrant(value: unknown): value is Grant {
  if (!object(value)) return false;
  return (
    validName(value.id) &&
    Array.isArray(value.accounts) &&
    value.accounts.length > 0 &&
    value.accounts.every(validName) &&
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    value.operations.every(validName) &&
    Number.isSafeInteger(value.expiresAt) &&
    Number(value.expiresAt) > 0 &&
    [value.dailyUnits, value.totalUnits].every(
      (x) => Number.isSafeInteger(x) && Number(x) > 0,
    )
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
      CREATE TABLE IF NOT EXISTS audit (request_id TEXT PRIMARY KEY, time INTEGER NOT NULL, grant_id TEXT NOT NULL, operation TEXT NOT NULL, account TEXT NOT NULL, outcome TEXT NOT NULL);`);
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
    this.db.prepare("UPDATE grants SET revoked=1 WHERE id=?").run(id);
  }
  reserve(
    token: string,
    operation: Operation,
    account: string,
    globalLimit: number,
    requestId: string,
    now = Date.now(),
  ): string {
    if (!/^[a-zA-Z0-9_-]{43,128}$/.test(token))
      throw new GatewayError(401, "unauthorized");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM grants WHERE token_hash=?")
        .get(hash(token));
      if (!row || row.revoked || !row.policy)
        throw new GatewayError(401, "unauthorized");
      const grant: unknown = JSON.parse(String(row.policy));
      if (
        !validGrant(grant) ||
        row.id !== grant.id ||
        !Number.isSafeInteger(row.used) ||
        Number(row.used) < 0
      )
        throw new GatewayError(503, "service_unavailable");
      if (grant.expiresAt <= now) throw new GatewayError(401, "unauthorized");
      if (
        !grant.operations.includes(operation) ||
        !grant.accounts.includes(account)
      )
        throw new GatewayError(403, "forbidden");
      const day = new Date(now).toISOString().slice(0, 10);
      if (Number(row.used) >= grant.totalUnits)
        throw new GatewayError(429, "quota_exceeded");
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
      this.db.prepare("UPDATE grants SET used=used+1 WHERE id=?").run(grant.id);
      this.db
        .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
        .run(requestId, now, grant.id, operation, account, "reserved");
      this.db.exec("COMMIT");
      return grant.id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finish(requestId: string, success: boolean) {
    this.db
      .prepare("UPDATE audit SET outcome=? WHERE request_id=?")
      .run(success ? "succeeded" : "failed", requestId);
  }
  close() {
    this.db.close();
  }
}
