import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import {
  Agent,
  request as httpsRequest,
  type RequestOptions,
} from "node:https";
import {
  validateHeaderName,
  validateHeaderValue,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { GatewayError, type Invocation, type Service } from "./model.ts";
import {
  canonicalPath,
  publicAddress,
  routeAllows,
  validateOrigin,
} from "./path-policy.ts";

export type RelayDependencies = {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
};
export type RelayResponse = {
  status: number;
  headers: Record<string, string>;
  encoding: "json" | "base64";
  body: unknown;
  rawBodyBase64?: string;
};

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "cookie",
  "cookie2",
  "set-cookie",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
  "forwarded",
  "via",
  "accept-encoding",
  "x-real-ip",
  "x-original-url",
  "x-rewrite-url",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);
const RESPONSE_HEADERS = new Set([
  "content-type",
  "content-language",
  "cache-control",
  "expires",
  "last-modified",
  "etag",
  "retry-after",
  "x-request-id",
  "request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
]);
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_TARGET_BYTES = 16 * 1024;

export function safeCallerHeader(name: string): boolean {
  const lower = name.toLowerCase();
  try {
    validateHeaderName(name);
  } catch {
    return false;
  }
  return (
    !FORBIDDEN_HEADERS.has(lower) &&
    !lower.startsWith("proxy-") &&
    !lower.startsWith("x-forwarded-") &&
    !lower.startsWith("sec-")
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function requestBody(input: Invocation, limit: number): Buffer | undefined {
  if (Object.hasOwn(input, "body") && input.bodyBase64 !== undefined) {
    throw new GatewayError(400, "invalid_request");
  }
  let body: Buffer | undefined;
  if (input.bodyBase64 !== undefined) {
    if (
      typeof input.bodyBase64 === "string" &&
      input.bodyBase64.length > Math.ceil(limit / 3) * 4
    )
      throw new GatewayError(413, "request_too_large");
    if (
      typeof input.bodyBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        input.bodyBase64,
      )
    ) {
      throw new GatewayError(400, "invalid_request");
    }
    body = Buffer.from(input.bodyBase64, "base64");
    if (body.toString("base64") !== input.bodyBase64)
      throw new GatewayError(400, "invalid_request");
  } else if (Object.hasOwn(input, "body")) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(input.body);
    } catch {
      throw new GatewayError(400, "invalid_request");
    }
    if (serialized === undefined)
      throw new GatewayError(400, "invalid_request");
    body = Buffer.from(serialized);
  }
  if (body && (input.method === "GET" || input.method === "HEAD"))
    throw new GatewayError(400, "invalid_request");
  if (body && body.length > limit)
    throw new GatewayError(413, "request_too_large");
  return body;
}

function prepare(input: Invocation, service: Service) {
  const origin = validateOrigin(service.origin);
  if (!METHODS.has(input.method))
    throw new GatewayError(400, "invalid_request");
  let path: string;
  try {
    path = canonicalPath(input.path);
  } catch {
    throw new GatewayError(400, "invalid_request");
  }
  if (
    service.access !== "service" &&
    !routeAllows(service.routes ?? [], input.method, path)
  )
    throw new GatewayError(403, "forbidden");
  const query = new URLSearchParams();
  if (input.query !== undefined) {
    if (!plainRecord(input.query))
      throw new GatewayError(400, "invalid_request");
    for (const [name, value] of Object.entries(input.query)) {
      if (
        !name ||
        /[\u0000-\u001f\u007f]/.test(name) ||
        (service.credential.type === "query" &&
          name.toLowerCase() === service.credential.name.toLowerCase())
      ) {
        throw new GatewayError(400, "invalid_request");
      }
      const values = Array.isArray(value) ? value : [value];
      if (
        values.length === 0 ||
        values.some((item) => typeof item !== "string")
      )
        throw new GatewayError(400, "invalid_request");
      for (const item of values) query.append(name, item as string);
    }
  }
  const headers: Record<string, string> = Object.create(null);
  const allowed = new Set(
    service.allowedHeaders.map((name) => name.toLowerCase()),
  );
  if (input.headers !== undefined) {
    if (!plainRecord(input.headers))
      throw new GatewayError(400, "invalid_request");
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (
        !safeCallerHeader(name) ||
        !allowed.has(lower) ||
        Object.hasOwn(headers, lower) ||
        typeof value !== "string" ||
        (service.credential.type === "header" &&
          lower === service.credential.name.toLowerCase())
      ) {
        throw new GatewayError(400, "invalid_request");
      }
      try {
        validateHeaderValue(name, value);
      } catch {
        throw new GatewayError(400, "invalid_request");
      }
      headers[lower] = value;
    }
  }
  const body = requestBody(input, service.maxRequestBytes);
  if (body && Object.hasOwn(input, "body") && !headers["content-type"])
    headers["content-type"] = "application/json";
  headers["accept-encoding"] = "identity";
  if (body) headers["content-length"] = String(body.length);
  const target = path + (query.size ? "?" + query.toString() : "");
  const headerBytes = Object.entries(headers).reduce(
    (size, [name, value]) => size + Buffer.byteLength(name + value) + 4,
    0,
  );
  if (
    headerBytes > MAX_HEADER_BYTES ||
    Buffer.byteLength(target) > MAX_TARGET_BYTES
  )
    throw new GatewayError(413, "request_too_large");
  return { origin, path, query, headers, body };
}

/** Defense in depth against ordinary credential echoes; not a malicious-provider DLP boundary. */
function containsCredential(bytes: Buffer, secrets: string[]): boolean {
  if (!secrets.length) return false;
  const variants = secrets
    .flatMap((secret) => {
      const base64 = Buffer.from(secret).toString("base64");
      return [
        secret,
        encodeURIComponent(secret),
        new URLSearchParams([["value", secret]])
          .toString()
          .slice("value=".length),
        [...Buffer.from(secret)]
          .map((byte) => "%" + byte.toString(16).padStart(2, "0"))
          .join(""),
        base64,
        base64.replace(/=+$/, ""),
        Buffer.from(secret).toString("base64url"),
        JSON.stringify(secret).slice(1, -1),
        secret
          .split("")
          .map(
            (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
          )
          .join(""),
      ];
    })
    .filter(Boolean);
  // Raw byte matching also protects binary and UTF-16 echoes without altering them.
  const byteVariants = secrets.flatMap((secret) => [
    Buffer.from(secret),
    Buffer.from(secret, "utf16le"),
    Buffer.from(secret, "utf16le").swap16(),
  ]);
  if (byteVariants.some((variant) => bytes.includes(variant))) return true;
  const pending = [{ text: bytes.toString("utf8"), depth: 0 }];
  const seen = new Set<string>();
  while (pending.length) {
    const { text, depth } = pending.pop()!;
    if (seen.has(text)) continue;
    seen.add(text);
    if (variants.some((variant) => text.includes(variant))) return true;
    if (depth >= 2) continue;
    // Decode mixed-case percent escapes, JSON unicode escapes and slash escapes.
    const unescaped = text.replace(
      /\\u([0-9a-f]{4})|\\([\\/"bfnrt])/gi,
      (_, hex: string, escaped: string) =>
        hex
          ? String.fromCharCode(Number.parseInt(hex, 16))
          : ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escaped] ??
            escaped),
    );
    if (unescaped !== text) pending.push({ text: unescaped, depth: depth + 1 });
    if (/%[0-9a-f]{2}|\+/i.test(text)) {
      // Include application/x-www-form-urlencoded echoes (spaces become '+').
      // Decode valid percent runs individually so a stray '%' cannot suppress scanning.
      for (const encoded of [text, text.replace(/\+/g, " ")]) {
        const decoded = encoded.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        });
        if (decoded !== text) pending.push({ text: decoded, depth: depth + 1 });
      }
    }
    for (const match of text.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) {
      const decodedBytes = Buffer.from(match[0], "base64");
      if (byteVariants.some((variant) => decodedBytes.includes(variant)))
        return true;
      const decoded = decodedBytes.toString("utf8");
      if (variants.some((variant) => decoded.includes(variant))) return true;
    }
  }
  return false;
}

export class Relay {
  private key: (service: string) => string;
  private resolve: NonNullable<RelayDependencies["resolve"]>;
  private request: NonNullable<RelayDependencies["request"]>;
  constructor(
    key: (service: string) => string,
    dependencies: RelayDependencies = {},
  ) {
    this.key = key;
    this.resolve =
      dependencies.resolve ??
      ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
    this.request = dependencies.request ?? httpsRequest;
  }

  /** This makes no DNS, network, key-store or other externally observable calls. */
  validate(input: Invocation, service: Service): void {
    prepare(input, service);
  }

  async invoke(input: Invocation, service: Service): Promise<RelayResponse> {
    const prepared = prepare(input, service);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, service.timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new GatewayError(504, "upstream_timeout")),
        { once: true },
      );
    });
    let agent: Agent | undefined;
    try {
      // Snapshot and inject the credential before the first await. A concurrent
      // configuration/key rotation must never send its new key to the old origin.
      const secrets: string[] = [];
      if (service.credential.type !== "none") {
        const key = this.key(input.service);
        if (typeof key !== "string" || !key || key.length > MAX_HEADER_BYTES)
          throw new Error("Missing credential");
        const value = (service.credential.prefix ?? "") + key;
        secrets.push(key, value);
        if (service.credential.type === "header") {
          validateHeaderName(service.credential.name);
          validateHeaderValue(service.credential.name, value);
          prepared.headers[service.credential.name.toLowerCase()] = value;
        } else prepared.query.append(service.credential.name, value);
      }
      const maxResponseBytes = service.maxResponseBytes;
      const method = input.method;
      const host = prepared.origin.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await Promise.race([this.resolve(host), aborted]);
      if (
        !addresses.length ||
        addresses.some(
          ({ address, family }) =>
            !publicAddress(address) || family !== isIP(address),
        )
      )
        throw new Error("Unsafe destination");
      const pinned = addresses[0]!;
      const lookup: LookupFunction = (_hostname, options, callback) => {
        // No second resolver call: every socket consumes the already validated answer.
        if (options.all)
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      };
      // A fresh non-proxy agent per invocation prevents pooled sockets from bypassing
      // destination validation. Do not use the environment-aware global Agent.
      agent = new Agent({
        keepAlive: false,
        maxCachedSessions: 0,
        proxyEnv: {},
      });
      if (controller.signal.aborted) throw new Error("Timed out");
      const path =
        prepared.path +
        (prepared.query.size ? "?" + prepared.query.toString() : "");
      if (
        Buffer.byteLength(path) > MAX_TARGET_BYTES ||
        Object.entries(prepared.headers).reduce(
          (size, [name, value]) => size + Buffer.byteLength(name + value) + 4,
          0,
        ) > MAX_HEADER_BYTES
      )
        throw new Error("Request target too large");
      const transport = new Promise<RelayResponse>((resolve, reject) => {
        const request = this.request(
          {
            protocol: "https:",
            hostname: host,
            port: prepared.origin.port || 443,
            path,
            method,
            headers: prepared.headers,
            agent,
            lookup,
            family: pinned.family,
            servername: isIP(host) ? "" : host,
            rejectUnauthorized: true,
            maxHeaderSize: MAX_HEADER_BYTES,
            signal: controller.signal,
          },
          (response) => {
            const fail = () => {
              response.destroy();
              request.destroy();
              reject(new Error("Unsafe upstream response"));
            };
            const status = response.statusCode ?? 0;
            if (
              status < 200 ||
              status >= 600 ||
              (status >= 300 && status < 400)
            ) {
              fail();
              return;
            }
            const encoding = response.headers["content-encoding"];
            if (encoding && encoding !== "identity") {
              fail();
              return;
            }
            const length = response.headers["content-length"];
            if (
              length &&
              (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)
            ) {
              fail();
              return;
            }
            if (
              containsCredential(
                Buffer.from(
                  JSON.stringify([response.rawHeaders, response.headers]),
                ),
                secrets,
              )
            ) {
              fail();
              return;
            }
            const headers: Record<string, string> = Object.create(null);
            for (const [name, value] of Object.entries(response.headers)) {
              if (
                RESPONSE_HEADERS.has(name.toLowerCase()) &&
                typeof value === "string"
              )
                headers[name.toLowerCase()] = value;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > maxResponseBytes) {
                fail();
                return;
              }
              chunks.push(buffer);
            });
            response.once("aborted", () =>
              reject(new Error("Incomplete upstream response")),
            );
            response.once("error", reject);
            response.once("end", () => {
              if (!response.complete) {
                reject(new Error("Incomplete upstream response"));
                return;
              }
              const body = Buffer.concat(chunks);
              if (containsCredential(body, secrets)) {
                reject(new Error("Credential in upstream response"));
                return;
              }
              const rawBodyBase64 = body.toString("base64");
              const contentType = response.headers["content-type"] ?? "";
              if (
                /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
              ) {
                try {
                  const decoded = new TextDecoder("utf-8", {
                    fatal: true,
                  }).decode(body);
                  const result: RelayResponse = {
                    status,
                    headers,
                    encoding: "json",
                    body: JSON.parse(decoded),
                    rawBodyBase64,
                  };
                  // JSON.parse can accept nesting that JSON.stringify cannot serialize.
                  // Verify the complete envelope before exposing a parsed response.
                  JSON.stringify(result);
                  resolve(result);
                  return;
                } catch {
                  /* Malformed or unreserializable JSON remains exact base64 bytes. */
                }
              }
              resolve({
                status,
                headers,
                encoding: "base64",
                body: rawBodyBase64,
              });
            });
          },
        );
        request.once("error", reject);
        request.once("upgrade", (_response, socket) => {
          socket.destroy();
          request.destroy();
          reject(new Error("Protocol upgrade rejected"));
        });
        request.end(prepared.body);
      });
      return await Promise.race([transport, aborted]);
    } catch {
      throw new GatewayError(
        timedOut ? 504 : 502,
        timedOut ? "upstream_timeout" : "upstream_unavailable",
      );
    } finally {
      clearTimeout(timer);
      agent?.destroy();
    }
  }
}
