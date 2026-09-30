import { readFileSync } from "node:fs";
import { parseConfig } from "./model.ts";
import { Store } from "./store.ts";
import { TikHub } from "./provider.ts";
import { AdapterRegistry } from "./registry.ts";
import { createGateway } from "./app.ts";
import { Settings } from "./settings.ts";
import { AdminAuth } from "./admin-auth.ts";
import { Admin } from "./admin.ts";
process.umask(0o077);
try {
  const configPath = process.env.GATEWAY_CONFIG ?? "./config.json";
  const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const port = Number(process.env.GATEWAY_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("port");
  const store = new Store(process.env.GATEWAY_DB ?? "./state/gateway.sqlite");
  const registry: AdapterRegistry = new AdapterRegistry([
    new TikHub((id): string => settings.key(id)),
  ]);
  registry.validateConfig(config);
  const settings: Settings = new Settings(
    config,
    configPath,
    process.env.GATEWAY_SECRETS ?? "./state/provider-keys.json",
    registry,
    process.env.TIKHUB_API_KEY ?? "",
  );
  const auth = new AdminAuth({
    file: process.env.ADMIN_PASSWORD_HASH_FILE ?? "./state/admin-password.hash",
  });
  const admin = new Admin(
    auth,
    settings,
    store,
    registry,
    process.env.ADMIN_ORIGIN ?? `http://127.0.0.1:${port}`,
  );
  const server = createGateway(config, store, registry, admin);
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
