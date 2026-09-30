import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { GatewayError, parseInvocation, type Config } from "./model.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { Store } from "./store.ts";
import type { Admin } from "./admin.ts";
async function readBody(req: IncomingMessage) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new GatewayError(415, "json_required");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new GatewayError(413, "request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GatewayError(400, "invalid_json");
  }
}
export function createGateway(
  config: Config,
  store: Store,
  registry: AdapterRegistry,
  admin?: Admin,
) {
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    let reserved = false;
    try {
      // Local-only MVP: reject browser-origin requests and DNS-rebinding hosts.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ""))
        throw new GatewayError(403, "forbidden");
      if (admin && (await admin.handle(req, res, readBody))) return;
      if (req.headers.origin) throw new GatewayError(403, "forbidden");
      if (req.method === "GET" && req.url === "/healthz") {
        send(200, { status: "ok" });
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/invoke")
        throw new GatewayError(404, "not_found");
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith("Bearer "))
        throw new GatewayError(401, "unauthorized");
      const input = parseInvocation(await readBody(req));
      const account = Object.hasOwn(config.accounts, input.account)
        ? config.accounts[input.account]
        : undefined;
      if (!account) throw new GatewayError(403, "forbidden");
      const provider = registry.resolve(input, account);
      store.reserve(
        authorization.slice(7),
        input.operation,
        input.account,
        config.globalDailyUnits,
        requestId,
      );
      reserved = true;
      const data = await provider.invoke(input, account);
      store.finish(requestId, true);
      send(200, { requestId, data });
    } catch (error) {
      if (reserved) {
        try {
          store.finish(requestId, false);
        } catch {
          /* no error details or credentials leave the process */
        }
      }
      const safe =
        error instanceof GatewayError
          ? error
          : new GatewayError(503, "service_unavailable");
      send(safe.status, { requestId, error: safe.code });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  server.maxHeadersCount = 30;
  return server;
}
