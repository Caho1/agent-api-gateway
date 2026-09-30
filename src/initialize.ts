import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
process.umask(0o077);
const path = process.env.GATEWAY_CONFIG;
if (!path) throw new Error("GATEWAY_CONFIG required");
if (!existsSync(path)) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({ accounts: {}, globalDailyUnits: 1000 }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
}
