import { readFileSync } from "node:fs";
import { parseConfig } from "./model.ts";
import { Store } from "./store.ts";
import { TikHub } from "./provider.ts";
import { AdapterRegistry } from "./registry.ts";
import { createGateway } from "./app.ts";
process.umask(0o077);
try {
  const config = parseConfig(
    JSON.parse(
      readFileSync(process.env.GATEWAY_CONFIG ?? "./config.json", "utf8"),
    ),
  );
  const port = Number(process.env.GATEWAY_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("port");
  const store = new Store(process.env.GATEWAY_DB ?? "./state/gateway.sqlite");
  const registry = new AdapterRegistry([
    new TikHub(process.env.TIKHUB_API_KEY ?? ""),
  ]);
  registry.validateConfig(config);
  const server = createGateway(config, store, registry);
  server.listen(port, "127.0.0.1", () =>
    console.log(`Gateway listening on 127.0.0.1:${port}`),
  );
  server.on("error", () => {
    console.error("Gateway startup failed");
    process.exitCode = 1;
    store.close();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(() => {
        store.close();
        process.exit(0);
      }),
    );
} catch {
  console.error(
    "Gateway startup failed: check local config, database and provider environment",
  );
  process.exitCode = 1;
}
