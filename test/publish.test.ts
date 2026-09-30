import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publisher = join(project, "publish.sh");

function fixture(options: { contract?: boolean; mode?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-publish-test-"));
  const root = join(directory, "production");
  const units = join(directory, "units");
  const repo = join(directory, "origin");
  const bin = join(directory, "bin");
  const old = join(root, "releases", "previous");
  const log = join(directory, "commands.log");
  for (const path of [root, units, repo, bin, old])
    mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Deployment Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Deployment Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Deployment Test");
  mkdirSync(join(repo, "deploy"));
  for (const name of [
    "build-release.sh",
    "agent-api-gateway.service",
    ...(options.contract === false ? [] : ["release-contract.json"]),
  ])
    cpSync(join(project, "deploy", name), join(repo, "deploy", name));
  cpSync(
    join(project, "ecosystem.config.cjs"),
    join(repo, "ecosystem.config.cjs"),
  );
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, "source.txt"), "validated-main\n");
  git("add", ".");
  git("commit", "-m", "Main release fixture");
  const revision = git("rev-parse", "HEAD");
  symlinkSync(old, join(root, "current"));
  const originalUnit = "[Service]\nExecStart=/old/node /old/server.js\n";
  writeFileSync(join(units, "agent-api-gateway.service"), originalUnit);
  const state = join(root, "protected-state");
  mkdirSync(state, { mode: 0o700 });
  const sentinels = [
    "config.json",
    "gateway.sqlite",
    "provider-keys.json",
    "admin-password.hash",
  ];
  for (const file of sentinels)
    writeFileSync(join(state, file), "unchanged-fixture", { mode: 0o600 });

  const executable = (name: string, source: string) =>
    writeFileSync(join(bin, name), source, { mode: 0o755 });
  executable(
    "systemd-run",
    `#!/bin/bash
set -eu
printf 'isolated-build %s\\n' "$*" >> "$TEST_LOG"
while [[ "$1" != -- ]]; do shift; done
shift
exec "$@"
`,
  );
  executable(
    "npm",
    `#!/bin/bash
set -eu
printf 'npm %s\\n' "$*" >> "$TEST_LOG"
if [[ "$*" = "ci --ignore-scripts --no-audit --no-fund" ]]; then
  mkdir -p node_modules/pm2/bin
  printf 'fixture-runtime\\n' > node_modules/pm2/bin/pm2-runtime
elif [[ "$*" = "run check" ]]; then
  [[ "$TEST_MODE" != build-fail ]] || exit 1
  mkdir -p dist
  printf 'fixture-server\\n' > dist/server.js
  printf 'fixture-initialize\\n' > dist/initialize.js
  if [[ "$TEST_MODE" = mutate-controls ]]; then
    printf '[Service]\\nUser=root\\nExecStart=/malicious-command\\n' > "$TEST_ORIGIN/evil.service"
    rm deploy/agent-api-gateway.service
    ln -s "$TEST_ORIGIN/evil.service" deploy/agent-api-gateway.service
    printf 'module.exports = {};\\n' > ecosystem.config.cjs
  fi
  if [[ "$TEST_MODE" = forged-activation ]]; then touch .activation-ready; fi
  if [[ "$TEST_MODE" = advance-main ]]; then
    printf 'new-main\\n' > "$TEST_ORIGIN/new-main.txt"
    git -C "$TEST_ORIGIN" add .
    git -C "$TEST_ORIGIN" commit -m 'Main advanced during build' >/dev/null
  fi
else exit 2
fi
`,
  );
  executable(
    "systemctl",
    `#!/bin/bash
set -eu
printf 'systemctl %s\\n' "$*" >> "$TEST_LOG"
if [[ "$1" = restart && "$TEST_MODE" = restart-fail && -f "$GATEWAY_DEPLOY_ROOT/current/.release.json" ]]; then exit 1; fi
exit 0
`,
  );
  executable(
    "curl",
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.TEST_MODE === 'baseline-fail') process.exit(22);
if (process.argv.at(-1).endsWith('/admin/api/status')) {
  const lost = process.env.TEST_MODE === 'admin-lost' && fs.existsSync(process.env.GATEWAY_DEPLOY_ROOT + '/current/.release.json');
  console.log(JSON.stringify({configured: !lost}));
} else {
  let release = 'old';
  try { release = JSON.parse(fs.readFileSync(process.env.GATEWAY_DEPLOY_ROOT + '/current/.release.json')).revision; } catch {}
  if (process.env.TEST_MODE === 'health-fail' && release !== 'old') release = 'wrong-revision';
  console.log(JSON.stringify({status:'ok',schemaVersion:2,release}));
}
`,
  );
  executable("sleep", "#!/bin/sh\nexit 0\n");

  const run = (...args: string[]) =>
    spawnSync("bash", [publisher, ...args], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        GATEWAY_DEPLOY_ROOT: root,
        GATEWAY_BUILD_ROOT: join(directory, "build"),
        GATEWAY_UNIT_DIR: units,
        GATEWAY_REPOSITORY_URL: repo,
        GATEWAY_NODE_BIN: bin,
        TEST_LOG: log,
        TEST_MODE: options.mode ?? "",
        TEST_ORIGIN: repo,
      },
    });
  return {
    directory,
    root,
    units,
    repo,
    old,
    originalUnit,
    revision,
    git,
    run,
    log: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    current: () => readlinkSync(join(root, "current")),
    assertPreserved: () => {
      for (const file of sentinels)
        assert.equal(
          readFileSync(join(state, file), "utf8"),
          "unchanged-fixture",
        );
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("publisher validates main in isolation, switches to PM2 and preserves state", () => {
  const f = fixture();
  try {
    f.git("checkout", "-b", "unmerged-feature");
    writeFileSync(join(f.repo, "unmerged.txt"), "must never deploy");
    f.git("add", ".");
    f.git("commit", "-m", "Unmerged branch");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(
      result.stdout,
      new RegExp(`Published and verified origin/main at ${f.revision}`),
    );
    assert.notEqual(f.current(), f.old);
    assert.equal(existsSync(join(f.current(), "unmerged.txt")), false);
    assert.equal(
      JSON.parse(readFileSync(join(f.current(), ".release.json"), "utf8"))
        .revision,
      f.revision,
    );
    assert.match(f.log(), /DynamicUser=yes/);
    assert.match(f.log(), /ProtectSystem=strict/);
    assert.match(
      f.log(),
      /StateDirectory=agent-api-gateway-build-[a-f0-9]{40}-/,
    );
    assert.match(f.log(), /npm ci --ignore-scripts/);
    assert.match(f.log(), /npm run check/);
    assert.match(
      readFileSync(join(f.units, "agent-api-gateway.service"), "utf8"),
      /pm2-runtime/,
    );
    assert.equal(readdirSync(join(f.directory, "build")).length, 0);
    assert.equal(existsSync(join(f.current(), ".activation-ready")), true);
    f.assertPreserved();
    const before = f.log();
    const repeated = f.run();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /Already running origin\/main/);
    assert.equal(
      (
        f
          .log()
          .slice(before.length)
          .match(/systemctl restart/g) ?? []
      ).length,
      0,
    );
  } finally {
    f.close();
  }
});

for (const mode of [
  "build-fail",
  "advance-main",
  "baseline-fail",
  "forged-activation",
]) {
  test(`publisher leaves production unchanged on ${mode}`, () => {
    const f = fixture({ mode });
    try {
      const result = f.run();
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(f.current(), f.old);
      assert.equal(
        readFileSync(join(f.units, "agent-api-gateway.service"), "utf8"),
        f.originalUnit,
      );
      assert.doesNotMatch(f.log(), /systemctl restart/);
      f.assertPreserved();
    } finally {
      f.close();
    }
  });
}

test("build code cannot replace the privileged service or activation configuration", () => {
  const f = fixture({ mode: "mutate-controls" });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(
      readFileSync(join(f.units, "agent-api-gateway.service"), "utf8"),
      readFileSync(join(project, "deploy/agent-api-gateway.service"), "utf8"),
    );
    assert.equal(
      readFileSync(join(f.current(), "ecosystem.config.cjs"), "utf8"),
      readFileSync(join(project, "ecosystem.config.cjs"), "utf8"),
    );
    assert.equal(
      readdirSync(f.root).some((name) => name.startsWith(".publish-control-")),
      false,
    );
    f.assertPreserved();
  } finally {
    f.close();
  }
});

for (const mode of ["restart-fail", "health-fail", "admin-lost"]) {
  test(`publisher rolls back code and unit on ${mode}`, () => {
    const f = fixture({ mode });
    try {
      const result = f.run();
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /Rollback verified/);
      assert.equal(f.current(), f.old);
      assert.equal(
        readFileSync(join(f.units, "agent-api-gateway.service"), "utf8"),
        f.originalUnit,
      );
      assert.equal((f.log().match(/systemctl restart/g) ?? []).length, 2);
      f.assertPreserved();
    } finally {
      f.close();
    }
  });
}

test("publisher refuses scaffold main before build or restart", () => {
  const f = fixture({ contract: false });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /lacks the reviewed relay\/PM2 release contract/,
    );
    assert.equal(f.current(), f.old);
    assert.doesNotMatch(f.log(), /isolated-build|systemctl restart/);
    f.assertPreserved();
  } finally {
    f.close();
  }
});

test("publisher refuses branch and revision arguments", () => {
  const f = fixture();
  try {
    const result = f.run("feature/do-not-deploy");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only origin\/main is publishable/);
    assert.equal(f.current(), f.old);
    assert.equal(f.log(), "");
  } finally {
    f.close();
  }
});

test("same-SHA publish refuses an interrupted activation without claiming success", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const current = f.current();
    rmSync(join(current, ".activation-ready"));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete activation/);
    assert.doesNotMatch(
      result.stdout,
      /Already running|Published and verified/,
    );
    assert.equal(f.current(), current);
    f.assertPreserved();
  } finally {
    f.close();
  }
});

test("same-SHA publish still checks the running revision", () => {
  const options = { mode: "" };
  const f = fixture(options);
  try {
    assert.equal(f.run().status, 0);
    options.mode = "health-fail";
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /existing release failed its revision health check/,
    );
    assert.doesNotMatch(result.stdout, /Already running/);
    f.assertPreserved();
  } finally {
    f.close();
  }
});

test("production unit keeps state identity and Caddy exposes only scoped routes", () => {
  const unit = readFileSync(
    join(project, "deploy/agent-api-gateway.service"),
    "utf8",
  );
  for (const expected of [
    "DynamicUser=yes",
    "User=agent-api-gateway",
    "StateDirectory=agent-api-gateway",
    "StateDirectoryMode=0700",
    "EnvironmentFile=/etc/agent-api-gateway/gateway.env",
    "PM2_HOME=/var/lib/agent-api-gateway/pm2",
    "ProtectSystem=strict",
    "pm2-runtime start",
  ])
    assert.ok(unit.includes(expected), expected);
  const caddy = readFileSync(join(project, "deploy/Caddyfile"), "utf8");
  assert.match(caddy, /@agent path \/v1\/relay \/v1\/invoke/);
  assert.match(caddy, /profile shortlived/);
  assert.match(caddy, /respond "Not found" 404/);
  assert.doesNotMatch(caddy, /tls_insecure_skip_verify|log \{|\/healthz/);
});
