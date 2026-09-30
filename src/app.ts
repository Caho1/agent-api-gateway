import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { GatewayError, object, parseInvocation, type Config } from "./model.ts";
import type { Relay } from "./relay.ts";
import type { Store } from "./store.ts";
import type { Admin } from "./admin.ts";
async function readBody(req: IncomingMessage) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new GatewayError(415, "json_required");
  const limit = req.url?.startsWith("/admin/") ? 65536 : 1500000;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new GatewayError(413, "request_too_large");
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
  relay: Pick<Relay, "validate" | "invoke">,
  admin?: Admin,
) {
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const send = (status: number, data: unknown) => {
      const serialized = JSON.stringify(data);
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(serialized);
    };
    let reserved = false;
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ""))
        throw new GatewayError(403, "forbidden");
      const activation = process.env.GATEWAY_ACTIVATION_FILE;
      if (activation && !existsSync(activation) && req.method !== "GET")
        throw new GatewayError(503, "deployment_in_progress");
      if (admin && (await admin.handle(req, res, readBody))) return;
      if (req.headers.origin) throw new GatewayError(403, "forbidden");
      if (req.method === "GET" && req.url === "/healthz") {
        send(200, {
          status: "ok",
          schemaVersion: 2,
          release: process.env.GATEWAY_RELEASE ?? "development",
        });
        return;
      }
      if (
        req.method !== "POST" ||
        !["/v1/relay", "/v1/invoke"].includes(req.url ?? "")
      )
        throw new GatewayError(404, "not_found");
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith("Bearer "))
        throw new GatewayError(401, "unauthorized");
      const input = parseInvocation(await readBody(req));
      const service = Object.hasOwn(config.services, input.service)
        ? config.services[input.service]
        : undefined;
      if (!service) throw new GatewayError(403, "forbidden");
      relay.validate(input, service);
      store.reserve(
        authorization.slice(7),
        input,
        config.globalDailyUnits,
        requestId,
      );
      reserved = true;
      const data = await relay.invoke(input, service);
      const status =
        object(data) && typeof data.status === "number"
          ? data.status
          : undefined;
      store.finish(requestId, status !== undefined && status < 400, status);
      send(200, { requestId, data });
    } catch (error) {
      if (reserved) {
        try {
          store.finish(requestId, false);
        } catch {
          /* never expose error data */
        }
      }
      const safe =
        error instanceof GatewayError
          ? error
          : new GatewayError(503, "service_unavailable");
      try {
        send(safe.status, { requestId, error: safe.code });
      } catch {
        res.destroy();
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 45000;
  server.maxHeadersCount = 30;
  return server;
}
