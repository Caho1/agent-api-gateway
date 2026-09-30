/* eslint-disable @typescript-eslint/no-require-imports -- PM2 requires a CommonJS ecosystem config. */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const release = JSON.parse(
  readFileSync(join(__dirname, ".release.json"), "utf8"),
);
if (!/^[a-f0-9]{40}$/.test(release.revision)) {
  throw new Error("Missing verified release revision");
}

module.exports = {
  apps: [
    {
      name: "agent-api-gateway",
      cwd: __dirname,
      script: "dist/server.js",
      interpreter: process.execPath,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 5,
      restart_delay: 1000,
      kill_timeout: 12000,
      max_memory_restart: "384M",
      // pm2-runtime streams the log bus to its inherited stdout/stderr. Reopening
      // /dev/stdout or /dev/stderr as files fails for systemd's journal sockets.
      out_file: "/dev/null",
      error_file: "/dev/null",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        GATEWAY_RELEASE: release.revision,
        GATEWAY_ACTIVATION_FILE: join(__dirname, ".activation-ready"),
      },
    },
  ],
};
