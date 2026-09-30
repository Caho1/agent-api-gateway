import { canonicalPath, validRoutes, validateOrigin } from "./path-policy.ts";
export const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export type Route = {
  methods: HttpMethod[];
  path: string;
  match: "exact" | "prefix";
};
export type Service = {
  origin: string;
  credential:
    | { type: "none" }
    | { type: "header" | "query"; name: string; prefix?: string };
  access: "service" | "routes";
  routes?: Route[];
  allowedHeaders: string[];
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
};
export type Config = {
  schemaVersion: 2;
  services: Record<string, Service>;
  globalDailyUnits: number;
  legacyAccounts?: Record<string, unknown>;
};
export type Invocation = {
  service: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyBase64?: string;
};
export const validName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(value);
export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const integer = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const forbiddenHeader =
  /^(?:authorization|proxy-.*|host|cookie2?|set-cookie|connection|keep-alive|transfer-encoding|te|trailer|upgrade|content-length|expect|via|sec-.*|forwarded|x-forwarded-.*|x-real-ip|x-original-url|x-rewrite-url|x-http-method-override|x-http-method|x-method-override|accept-encoding)$/i;
export function parseService(raw: unknown, legacyDefault = false): Service {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (k) =>
        ![
          "origin",
          "credential",
          "routes",
          "access",
          "allowedHeaders",
          "timeoutMs",
          "maxRequestBytes",
          "maxResponseBytes",
        ].includes(k),
    )
  )
    throw new Error("Invalid service");
  if (typeof raw.origin !== "string") throw new Error("Invalid origin");
  validateOrigin(raw.origin);
  const credential = raw.credential ?? { type: "none" };
  if (
    !object(credential) ||
    !["none", "header", "query"].includes(String(credential.type))
  )
    throw new Error("Invalid credential configuration");
  if (credential.type === "none") {
    if (Object.keys(credential).length !== 1)
      throw new Error("Invalid credential configuration");
  } else {
    if (
      Object.keys(credential).some(
        (k) => !["type", "name", "prefix"].includes(k),
      ) ||
      typeof credential.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(credential.name) ||
      (credential.prefix !== undefined &&
        (typeof credential.prefix !== "string" ||
          credential.prefix.length > 100 ||
          /[^\x20-\x7e]/.test(credential.prefix)))
    )
      throw new Error("Invalid credential configuration");
    if (
      credential.type === "header" &&
      credential.name.toLowerCase() !== "authorization" &&
      forbiddenHeader.test(credential.name)
    )
      throw new Error("Invalid credential header");
  }
  // Old persisted services without a mode keep their previous deny-by-default semantics.
  // New admin/API definitions default to whole-service access unless legacy routes are explicit.
  const access =
    raw.access ??
    (legacyDefault || Object.hasOwn(raw, "routes") ? "routes" : "service");
  if (access !== "service" && access !== "routes")
    throw new Error("Invalid access mode");
  if (access === "service" && Object.hasOwn(raw, "routes"))
    throw new Error("Service access cannot contain routes");
  const routes = access === "routes" ? (raw.routes ?? []) : undefined;
  const allowedHeaders = raw.allowedHeaders ?? ["accept", "content-type"];
  if (
    (access === "routes" && !validRoutes(routes)) ||
    !Array.isArray(allowedHeaders) ||
    allowedHeaders.length > 30 ||
    !allowedHeaders.every(
      (h) =>
        typeof h === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(h) &&
        !forbiddenHeader.test(h),
    ) ||
    new Set(allowedHeaders).size !== allowedHeaders.length ||
    (credential.type === "header" &&
      allowedHeaders.includes(String(credential.name).toLowerCase()))
  )
    throw new Error("Invalid policy");
  const timeoutMs = raw.timeoutMs ?? 10000,
    maxRequestBytes = raw.maxRequestBytes ?? 262144,
    maxResponseBytes = raw.maxResponseBytes ?? 1048576;
  if (
    !integer(timeoutMs, 100, 30000) ||
    !integer(maxRequestBytes, 1, 1048576) ||
    !integer(maxResponseBytes, 1, 8388608)
  )
    throw new Error("Invalid limits");
  return {
    origin: raw.origin,
    credential: credential as Service["credential"],
    access,
    ...(access === "routes" ? { routes: routes as Route[] } : {}),
    allowedHeaders,
    timeoutMs: Number(timeoutMs),
    maxRequestBytes: Number(maxRequestBytes),
    maxResponseBytes: Number(maxResponseBytes),
  };
}
export function parseConfig(raw: unknown): Config {
  if (!object(raw) || !integer(raw.globalDailyUnits, 1, 1000000))
    throw new Error("Invalid config");
  // Preserve the old file's account data, without interpreting it as generic authority.
  if (
    raw.schemaVersion === undefined &&
    object(raw.accounts) &&
    raw.services === undefined
  ) {
    return {
      schemaVersion: 2,
      services: Object.create(null),
      globalDailyUnits: Number(raw.globalDailyUnits),
      legacyAccounts: raw.accounts,
    };
  }
  if (
    raw.schemaVersion !== 2 ||
    !object(raw.services) ||
    Object.keys(raw.services).length > 100 ||
    Object.keys(raw).some(
      (k) =>
        ![
          "schemaVersion",
          "services",
          "globalDailyUnits",
          "legacyAccounts",
        ].includes(k),
    ) ||
    (raw.legacyAccounts !== undefined && !object(raw.legacyAccounts))
  )
    throw new Error("Invalid config");
  const services: Record<string, Service> = Object.create(null);
  for (const [id, service] of Object.entries(raw.services)) {
    if (!validName(id)) throw new Error("Invalid service id");
    services[id] = parseService(service, true);
  }
  return {
    schemaVersion: 2,
    services,
    globalDailyUnits: Number(raw.globalDailyUnits),
    ...(raw.legacyAccounts === undefined
      ? {}
      : { legacyAccounts: raw.legacyAccounts as Record<string, unknown> }),
  };
}
export function parseInvocation(raw: unknown): Invocation {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (k) =>
        ![
          "service",
          "method",
          "path",
          "query",
          "headers",
          "body",
          "bodyBase64",
        ].includes(k),
    ) ||
    !validName(raw.service) ||
    !HTTP_METHODS.includes(raw.method as HttpMethod) ||
    typeof raw.path !== "string"
  )
    throw new GatewayError(400, "invalid_request");
  try {
    canonicalPath(raw.path);
  } catch {
    throw new GatewayError(400, "invalid_path");
  }
  if (
    raw.query !== undefined &&
    (!object(raw.query) ||
      Object.keys(raw.query).length > 100 ||
      !Object.entries(raw.query).every(
        ([k, v]) =>
          k.length > 0 &&
          k.length <= 256 &&
          !/[\x00-\x1f\x7f]/.test(k) &&
          (typeof v === "string" ||
            (Array.isArray(v) &&
              v.length <= 100 &&
              v.every((x) => typeof x === "string"))),
      ))
  )
    throw new GatewayError(400, "invalid_query");
  if (
    raw.headers !== undefined &&
    (!object(raw.headers) ||
      Object.keys(raw.headers).length > 30 ||
      !Object.entries(raw.headers).every(
        ([k, v]) =>
          /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k) &&
          typeof v === "string" &&
          v.length <= 8192 &&
          !/[^\x20-\x7e]/.test(v),
      ))
  )
    throw new GatewayError(400, "invalid_headers");
  if (Object.hasOwn(raw, "body") && Object.hasOwn(raw, "bodyBase64"))
    throw new GatewayError(400, "invalid_body");
  if (
    raw.bodyBase64 !== undefined &&
    (typeof raw.bodyBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw.bodyBase64,
      ))
  )
    throw new GatewayError(400, "invalid_body");
  if (
    ["GET", "HEAD"].includes(String(raw.method)) &&
    (Object.hasOwn(raw, "body") || Object.hasOwn(raw, "bodyBase64"))
  )
    throw new GatewayError(400, "invalid_body");
  return raw as Invocation;
}
