import { request } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Store, type Grant } from "../src/store.ts";
import {
  parseConfig,
  parseInvocation,
  parseService,
  type Invocation,
  type Route,
} from "../src/model.ts";
import { Relay } from "../src/relay.ts";
import { createGateway } from "../src/app.ts";
const token = "FAKE_TEST_CREDENTIAL_NOT_FOR_USE_01234567890123456789";
const routes: Route[] = [
  { methods: ["GET", "POST"], path: "/v1", match: "prefix" },
];
const input: Invocation = { service: "mine", method: "GET", path: "/v1/items" };
const policy = (id = "test", dailyUnits = 3): Grant => ({
  schemaVersion: 2,
  id,
  services: ["mine"],
  routes,
  expiresAt: Date.now() + 60000,
  dailyUnits,
  totalUnits: 10,
  perMinute: 10,
});
const service = parseService({ origin: "https://api.example.com", routes });
const config = parseConfig({
  schemaVersion: 2,
  services: { mine: service },
  globalDailyUnits: 5,
});
test("strict generic invocation rejects business adapters, absolute paths and unsupported shape", () => {
  assert.deepEqual(parseInvocation(input), input);
  for (const value of [
    { operation: "posts.list", account: "mine", args: {} },
    { ...input, url: "https://evil" },
    { ...input, path: "https://example.com" },
    { ...input, path: "//example.com" },
    { ...input, method: "TRACE" },
    { ...input, body: {} },
    { ...input, method: "POST", body: {}, bodyBase64: "eA==" },
    { ...input, query: { count: 10 } },
    { ...input, headers: { accept: 2 } },
  ])
    assert.throws(() => parseInvocation(value));
});
test("legacy configuration is preserved with no inferred service authority", () => {
  const old = {
    accounts: {
      mine: {
        provider: "tikhub",
        settings: { secUid: "private", postIds: ["1"] },
      },
    },
    globalDailyUnits: 5,
  };
  const next = parseConfig(old);
  assert.equal(next.schemaVersion, 2);
  assert.equal(Object.keys(next.services).length, 0);
  assert.deepEqual(next.legacyAccounts, old.accounts);
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(next))), next);
  assert.throws(() => parseConfig({ ...next, schemaVersion: 3 }));
  assert.deepEqual(
    parseService({ origin: "https://api.example.com" }).routes,
    [],
  );
  for (const name of [
    "Host",
    "Content-Length",
    "Connection",
    "Cookie",
    "X-Forwarded-For",
  ])
    assert.throws(() =>
      parseService({
        origin: "https://api.example.com",
        credential: { type: "header", name },
      }),
    );
});
test("scope, expiry, revocation, total/daily quota and fail-closed policy", () => {
  const store = new Store(":memory:");
  try {
    store.create(policy(), token);
    assert.throws(() => store.reserve("bad", input, 5, "bad"), /unauthorized/);
    assert.throws(
      () => store.reserve(token, { ...input, service: "other" }, 5, "scope"),
      /forbidden/,
    );
    assert.throws(
      () => store.reserve(token, { ...input, path: "/v10" }, 5, "path"),
      /forbidden/,
    );
    assert.throws(
      () => store.reserve(token, { ...input, method: "DELETE" }, 5, "method"),
      /forbidden/,
    );
    assert.throws(
      () => store.reserve(token, input, 5, "expiry", Date.now() + 120000),
      /unauthorized/,
    );
    for (let i = 0; i < 3; i++) store.reserve(token, input, 5, "r" + i);
    assert.throws(
      () => store.reserve(token, input, 5, "over"),
      /quota_exceeded/,
    );
    store.revoke("test");
    assert.throws(
      () => store.reserve(token, input, 5, "revoked"),
      /unauthorized/,
    );
    assert.equal(store.audit().length, 3);
  } finally {
    store.close();
  }
});
test("legacy grants never gain generic authority; malformed policies do not break admin", () => {
  const store = new Store(":memory:");
  try {
    store.db
      .prepare("INSERT INTO grants(id,token_hash,policy) VALUES(?,?,?)")
      .run(
        "old",
        createHash("sha256").update(token).digest("hex"),
        JSON.stringify({
          id: "old",
          accounts: ["mine"],
          operations: ["posts.list"],
          expiresAt: Date.now() + 60000,
          dailyUnits: 3,
          totalUnits: 4,
        }),
      );
    assert.throws(
      () => store.reserve(token, input, 5, "legacy"),
      /unauthorized/,
    );
    assert.equal(store.summary().grants[0]!.status, "migration_required");
    assert.equal(store.summary().globalUsed, 0);
    store.db.prepare("UPDATE grants SET policy='invalid' WHERE id='old'").run();
    assert.equal(store.summary().grants[0]!.status, "migration_required");
  } finally {
    store.close();
  }
});
test("rate limiting is atomic and only commits for successful reservations", () => {
  const store = new Store(":memory:");
  try {
    const now = Math.floor(Date.now() / 60000) * 60000 + 1000;
    store.create({ ...policy(), expiresAt: now + 180000, perMinute: 1 }, token);
    store.reserve(token, input, 5, "first", now);
    assert.throws(
      () => store.reserve(token, input, 5, "fast", now + 1),
      /rate_exceeded/,
    );
    assert.equal(store.summary().globalUsed, 1);
    store.reserve(token, input, 5, "next", now + 60000);
    assert.equal(store.summary().grants[0]!.used, 2);
  } finally {
    store.close();
  }
});
test("durable quota survives restart and daily reset does not reset total", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-store-")),
    path = join(dir, "db");
  try {
    let store = new Store(path);
    store.create(
      { ...policy(), totalUnits: 1, expiresAt: Date.now() + 172800000 },
      token,
    );
    store.reserve(token, input, 1, "first");
    store.close();
    store = new Store(path);
    try {
      assert.throws(
        () => store.reserve(token, input, 5, "tomorrow", Date.now() + 86400000),
        /quota_exceeded/,
      );
      store.create(policy("two"), token + "2");
      assert.throws(
        () => store.reserve(token + "2", input, 1, "global"),
        /quota_exceeded/,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("concurrent processes cannot exceed quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-concurrency-")),
    path = join(dir, "db");
  try {
    const store = new Store(path);
    store.create(policy(), token);
    store.close();
    const script = `import{Store}from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};const s=new Store(process.argv[1]);try{s.reserve(process.argv[2],${JSON.stringify(input)},50,process.argv[3]);console.log('ok')}catch{console.log('denied')}finally{s.close()}`;
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        (_, i) =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [
              "--experimental-strip-types",
              "--input-type=module",
              "-e",
              script,
              path,
              token,
              String(i),
            ]);
            let out = "",
              err = "";
            child.stdout.on("data", (x) => (out += x));
            child.stderr.on("data", (x) => (err += x));
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0 ? resolve(out.trim()) : reject(new Error(err)),
            );
          }),
      ),
    );
    assert.equal(results.filter((x) => x === "ok").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("gateway reserves before transport, returns unnormalized envelope and sanitized failure", async () => {
  const store = new Store(":memory:");
  store.create(policy(), token);
  let calls = 0;
  const validator = new Relay(() => "");
  const server = createGateway(config, store, {
    validate: (i, s) => validator.validate(i, s),
    invoke: async () => {
      calls++;
      assert.equal(store.summary().globalUsed, calls);
      if (calls === 2) throw new Error("secret remote error");
      return {
        status: 200,
        headers: {},
        encoding: "json",
        body: { arbitrary: [1, { foo: "bar" }] },
        rawBodyBase64: "e30=",
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/v1/relay", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await call({ ...input, path: "/blocked" })).status, 403);
    assert.equal(calls, 0);
    const first = await call(input);
    assert.equal(first.status, 200);
    const data = (await first.json()) as { data: { body: unknown } };
    assert.deepEqual(data.data.body, { arbitrary: [1, { foo: "bar" }] });
    const second = await call(input);
    assert.equal(second.status, 503);
    assert.ok(!(await second.text()).includes("secret"));
    assert.equal(
      (await call(input, { origin: "https://evil.example" })).status,
      403,
    );
    const hostStatus = await new Promise<number>((resolve) => {
      const req = request(
        base + "/healthz",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal(store.summary().globalUsed, 2);
    assert.equal(store.audit().filter((x) => x.outcome === "failed").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
test("empty service and grant routes deny by default", () => {
  const relay = new Relay(() => "");
  assert.throws(
    () => relay.validate(input, { ...service, routes: [] }),
    /forbidden/,
  );
  const store = new Store(":memory:");
  try {
    store.create({ ...policy(), routes: [] }, token);
    assert.throws(() => store.reserve(token, input, 5, "empty"), /forbidden/);
  } finally {
    store.close();
  }
});

test("deep relay values cannot crash response serialization", async () => {
  const store = new Store(":memory:");
  store.create(policy(), token);
  const server = createGateway(config, store, {
    validate: () => {},
    invoke: async () => ({
      status: 200,
      headers: {},
      encoding: "json",
      body: JSON.parse("[".repeat(10000) + "0" + "]".repeat(10000)),
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const base = "http://127.0.0.1:" + addr.port;
  try {
    const response = await fetch(base + "/v1/relay", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 503);
    assert.equal((await fetch(base + "/healthz")).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
test("release activation gate blocks mutations and upstream until exact release health passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-activation-")),
    marker = join(dir, "ready");
  const previous = process.env.GATEWAY_ACTIVATION_FILE;
  process.env.GATEWAY_ACTIVATION_FILE = marker;
  const store = new Store(":memory:");
  store.create(policy(), token);
  let calls = 0;
  const server = createGateway(config, store, {
    validate: () => {},
    invoke: async () => {
      calls++;
      return { status: 200, headers: {}, encoding: "base64", body: "" };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const base = "http://127.0.0.1:" + addr.port;
  const post = (path: string) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  try {
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await post("/v1/relay")).status, 503);
    assert.equal((await post("/admin/api/login")).status, 503);
    assert.equal(calls, 0);
    assert.equal(store.summary().globalUsed, 0);
    writeFileSync(marker, "");
    assert.equal((await post("/v1/relay")).status, 200);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_ACTIVATION_FILE;
    else process.env.GATEWAY_ACTIVATION_FILE = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
