import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { passwordHash } from "./admin-auth.ts";
process.umask(0o077);
async function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Use an interactive SSH terminal");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (data: Buffer) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " " && value.length < 257) value += character;
      }
    };
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    process.stdin.on("data", onData);
  });
}
try {
  const password = await hidden("Admin password (16–256 characters, hidden): ");
  const confirm = await hidden("Repeat password (hidden): ");
  if (password !== confirm) throw new Error("Passwords differ");
  const hash = await passwordHash(password);
  const path =
    process.env.ADMIN_PASSWORD_HASH_FILE ?? "./state/admin-password.hash";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, hash + "\n", { mode: 0o600, flag: "wx" });
  console.log(
    "Admin password hash saved. Restart the gateway to enable login.",
  );
} catch (error) {
  console.error(
    error instanceof Error &&
      [
        "Use 16–256 characters",
        "Passwords differ",
        "Use an interactive SSH terminal",
        "Cancelled",
      ].includes(error.message)
      ? error.message
      : "Setup failed; existing password file will not be overwritten.",
  );
  process.exitCode = 1;
}
