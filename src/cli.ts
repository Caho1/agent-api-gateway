import { readFileSync } from "node:fs";
import { Store, type Grant } from "./store.ts";
process.umask(0o077);
let store: Store | undefined;
try {
  const [command, value] = process.argv.slice(2);
  if (!value || !["grant", "revoke", "audit"].includes(command ?? ""))
    throw new Error("usage");
  store = new Store(process.env.GATEWAY_DB ?? "./state/gateway.sqlite");
  if (command === "grant") {
    const grant = JSON.parse(readFileSync(value, "utf8")) as Grant;
    const token = store.create(grant);
    console.log(
      JSON.stringify({
        id: grant.id,
        token,
        note: "Shown once. Store securely; never share the provider key.",
      }),
    );
  } else if (command === "revoke") {
    store.revoke(value);
    console.log("Grant revoked if present");
  } else {
    if (!/^\d{1,3}$/.test(value) || Number(value) < 1) throw new Error("limit");
    console.log(
      JSON.stringify(
        store.db
          .prepare("SELECT * FROM audit ORDER BY time DESC LIMIT ?")
          .all(Number(value)),
        null,
        2,
      ),
    );
  }
} catch {
  console.error(
    "Command failed. Usage: npm run cli -- grant POLICY.json | revoke GRANT_ID | audit LIMIT",
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
