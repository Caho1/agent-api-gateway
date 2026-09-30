import { isIP } from "node:net";
import type { HttpMethod, Route } from "./model.ts";

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/** A conservative public-unicast policy, including transition/tunnel exclusions. */
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  // Only native global unicast. This also excludes mapped IPv4, NAT64, local,
  // multicast, unspecified, link-local and other reserved IPv6 address spaces.
  const groups = address.toLowerCase().split(":");
  const first = Number.parseInt(groups[0] || "0", 16);
  const second = Number.parseInt(groups[1] || "0", 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second <= 0x0fff)
  );
}

export function validateOrigin(origin: string): URL {
  if (
    typeof origin !== "string" ||
    /[\s\\\u0000-\u001f\u007f]/u.test(origin) ||
    !/^https:\/\/[^/?#]+\/?$/i.test(origin)
  )
    throw new Error("Invalid service origin");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("Invalid service origin");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    origin.slice(origin.indexOf("://") + 3).includes("@") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    /[?#]/.test(origin) ||
    !host ||
    (isIP(host)
      ? !publicAddress(host)
      : !/^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(
          host,
        )) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|onion)\.?$/i.test(host)
  ) {
    throw new Error("Invalid service origin");
  }
  return url;
}

/** Return one unambiguous encoded path, rejecting forms servers normalize differently. */
export function canonicalPath(path: string): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 8192 ||
    /[\\?#;\u0000-\u0020\u007f-\u009f]/u.test(path) ||
    /%(?:2f|5c|25)/i.test(path)
  ) {
    throw new Error("Invalid path");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error("Invalid path");
  }
  if (
    /[\\?#%;\u0000-\u0020\u007f-\u009f]/u.test(decoded) ||
    decoded.includes("//") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid path");
  }
  return decoded
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function validRoutes(value: unknown): value is Route[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((route) => {
      if (
        !route ||
        typeof route !== "object" ||
        Array.isArray(route) ||
        Object.keys(route).some(
          (key) => !["methods", "path", "match"].includes(key),
        ) ||
        !Array.isArray(route.methods) ||
        route.methods.length === 0 ||
        route.methods.some(
          (method: unknown) =>
            typeof method !== "string" || !METHODS.has(method),
        ) ||
        new Set(route.methods).size !== route.methods.length ||
        (route.match !== "exact" && route.match !== "prefix")
      )
        return false;
      try {
        return (
          typeof route.path === "string" &&
          canonicalPath(route.path) === route.path
        );
      } catch {
        return false;
      }
    })
  );
}

export function routeAllows(
  routes: Route[],
  method: HttpMethod,
  path: string,
): boolean {
  let canonical: string;
  try {
    canonical = canonicalPath(path);
  } catch {
    return false;
  }
  return routes.some(
    (route) =>
      route.methods.includes(method) &&
      (canonical === route.path ||
        (route.match === "prefix" &&
          canonical.startsWith(
            route.path.endsWith("/") ? route.path : route.path + "/",
          ))),
  );
}
