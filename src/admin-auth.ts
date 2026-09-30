import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { GatewayError } from "./model.ts";
const derive = promisify(scrypt);
export async function passwordHash(password: string) {
  if (password.length < 16 || password.length > 256)
    throw new Error("Use 16–256 characters");
  const salt = randomBytes(16).toString("hex");
  const digest = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${digest.toString("hex")}`;
}
type Session = { csrf: string; expiresAt: number };
export class AdminAuth {
  private hash: string | undefined;
  private sessions = new Map<string, Session>();
  private failures = 0;
  private windowStart = Date.now();
  private pending = 0;
  constructor(hashOrFile?: { hash?: string; file?: string }) {
    if (hashOrFile?.file) {
      try {
        this.hash = readFileSync(hashOrFile.file, "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else this.hash = hashOrFile?.hash;
    if (this.hash && !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(this.hash))
      throw new Error("Invalid admin hash");
  }
  get configured() {
    return Boolean(this.hash);
  }
  async login(password: unknown) {
    if (!this.hash) throw new GatewayError(503, "admin_setup_required");
    if (Date.now() - this.windowStart >= 60_000) {
      this.windowStart = Date.now();
      this.failures = 0;
    }
    if (this.failures >= 5 || this.pending >= 2)
      throw new GatewayError(429, "try_later");
    this.failures++;
    if (typeof password !== "string" || password.length > 256)
      throw new GatewayError(401, "invalid_credentials");
    const [, salt, expected] = this.hash.split(":");
    this.pending++;
    try {
      const actual = (await derive(password, salt!, 64)) as Buffer;
      if (!timingSafeEqual(actual, Buffer.from(expected!, "hex")))
        throw new GatewayError(401, "invalid_credentials");
    } finally {
      this.pending--;
    }
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= Date.now()) this.sessions.delete(key);
    if (this.sessions.size >= 20) throw new GatewayError(429, "try_later");
    const token = randomBytes(32).toString("base64url");
    const session = {
      csrf: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 30 * 60_000,
    };
    this.sessions.set(token, session);
    return { token, ...session };
  }
  session(cookie: string | undefined) {
    const token = cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("gateway_admin="))
      ?.slice(14);
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) this.sessions.delete(token);
      throw new GatewayError(401, "admin_unauthorized");
    }
    return { token: token!, ...session };
  }
  logout(token: string) {
    this.sessions.delete(token);
  }
}
