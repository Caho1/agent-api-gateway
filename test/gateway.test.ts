import { request } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store, type Grant } from "../src/store.ts";
import { parseConfig, parseInvocation } from "../src/model.ts";
import { TikHub } from "../src/provider.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { createGateway } from "../src/app.ts";
const token = "FAKE_TEST_CREDENTIAL_NOT_FOR_USE_01234567890123456789";
const policy = (id = "test", dailyUnits = 3): Grant => ({
  id,
  accounts: ["mine"],
  operations: ["posts.list", "posts.metrics"],
  expiresAt: Date.now() + 60_000,
  dailyUnits,
  totalUnits: 10,
});
const config = parseConfig({
  accounts: {
    mine: {
      provider: "tikhub",
      settings: { secUid: "mine-sec-uid", postIds: ["123"] },
    },
  },
  globalDailyUnits: 5,
});
const account = config.accounts.mine!;
const list = { operation: "posts.list" as const, account: "mine", args: {} };
const reply = (data: unknown) =>
  new Response(JSON.stringify({ code: 200, data }), {
    headers: { "content-type": "application/json" },
  });

test("strict invocation rejects arbitrary URLs and arguments", () => {
  assert.deepEqual(parseInvocation(list), list);
  for (const value of [
    { ...list, url: "https://evil" },
    { ...list, args: { url: "https://evil" } },
    { ...list, operation: "delete" },
    { ...list, args: { cursor: "https://evil" } },
    {
      operation: "posts.metrics",
      account: "mine",
      args: { postId: "123", extra: 1 },
    },
  ])
    assert.throws(() =>
      new AdapterRegistry([new TikHub("FAKE_KEY")]).resolve(
        parseInvocation(value),
        account,
      ),
    );
});
test("scope, expiry, revocation and quota fail closed", () => {
  const store = new Store(":memory:");
  store.create(policy(), token);
  assert.throws(
    () => store.reserve("bad", "posts.list", "mine", 5, "bad"),
    /unauthorized/,
  );
  assert.throws(
    () => store.reserve(token, "posts.list", "other", 5, "scope"),
    /forbidden/,
  );
  assert.throws(
    () =>
      store.reserve(
        token,
        "posts.list",
        "mine",
        5,
        "expiry",
        Date.now() + 120_000,
      ),
    /unauthorized/,
  );
  for (let i = 0; i < 3; i++)
    store.reserve(token, "posts.list", "mine", 5, "r" + i);
  assert.throws(
    () => store.reserve(token, "posts.list", "mine", 5, "over"),
    /quota_exceeded/,
  );
  store.revoke("test");
  assert.throws(
    () => store.reserve(token, "posts.list", "mine", 5, "revoked"),
    /unauthorized/,
  );
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM audit").get()!.n, 3);
  store.close();
});
test("durable global and total quota survive restart; daily reset does not reset total", () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-"));
  const path = join(dir, "db");
  try {
    let store = new Store(path);
    const p = policy();
    p.totalUnits = 1;
    p.expiresAt = Date.now() + 172_800_000;
    store.create(p, token);
    store.reserve(token, "posts.list", "mine", 1, "first");
    store.close();
    store = new Store(path);
    assert.throws(
      () =>
        store.reserve(
          token,
          "posts.list",
          "mine",
          5,
          "tomorrow",
          Date.now() + 86_400_000,
        ),
      /quota_exceeded/,
    );
    store.create(policy("two"), token + "2");
    assert.throws(
      () => store.reserve(token + "2", "posts.list", "mine", 1, "global"),
      /quota_exceeded/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("concurrent processes cannot overrun quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-"));
  const path = join(dir, "db");
  try {
    const store = new Store(path);
    store.create(policy(), token);
    store.close();
    const script = `import {Store} from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};const s=new Store(process.argv[1]);try{s.reserve(process.argv[2],'posts.list','mine',50,process.argv[3]);console.log('ok')}catch{console.log('denied')}finally{s.close()}`;
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
            let out = "";
            let err = "";
            child.stderr.on("data", (x) => (err += x));
            child.stdout.on("data", (x) => (out += x));
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0
                ? resolve(out.trim())
                : reject(new Error("child failed: " + err)),
            );
          }),
      ),
    );
    assert.equal(results.filter((x) => x === "ok").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("adapter fixed host, safe GET options, ownership and redaction", async () => {
  const key = "FAKE_PROVIDER_KEY";
  let called = 0;
  const provider = new TikHub(key, async (url, options) => {
    called++;
    assert.equal(new URL(String(url)).origin, "https://api.tikhub.io");
    assert.equal(
      new URL(String(url)).pathname,
      "/api/v1/douyin/app/v3/fetch_user_post_videos",
    );
    assert.equal(options?.redirect, "error");
    assert.equal(options?.method, "GET");
    assert.ok(options?.signal);
    return new Response(
      '{"code":200,"data":{"aweme_list":[{"aweme_id":7340000000000000001,"desc":"FAKE_PROVIDER_KEY hello","author":{"sec_uid":"mine-sec-uid"}}],"max_cursor":1700000000000}}',
    );
  });
  const result = (await provider.invoke(list, account)) as {
    posts: { id: string; title: string }[];
  };
  assert.equal(called, 1);
  assert.equal(result.posts[0]!.id, "7340000000000000001");
  assert.equal(result.posts[0]!.title, "[REDACTED] hello");
  const foreign = new TikHub(key, async () =>
    reply({
      aweme_list: [{ aweme_id: "123", author: { sec_uid: "foreign" } }],
    }),
  );
  await assert.rejects(foreign.invoke(list, account), /upstream_unavailable/);
});
test("adapter no retry, sanitized errors, response bound, missing metrics remain null", async () => {
  let calls = 0;
  const failure = new TikHub("FAKE_KEY", async () => {
    calls++;
    throw new Error("FAKE_KEY secret upstream body");
  });
  await assert.rejects(
    failure.invoke(list, account),
    /^Error: upstream_unavailable$/,
  );
  assert.equal(calls, 1);
  const large = new TikHub(
    "FAKE_KEY",
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  );
  await assert.rejects(large.invoke(list, account), /upstream_unavailable/);
  const metrics = new TikHub("FAKE_KEY", async () =>
    reply({ statistics_list: [{ aweme_id: "123", play_count: null }] }),
  );
  const out = (await metrics.invoke(
    { operation: "posts.metrics", account: "mine", args: { postId: "123" } },
    account,
  )) as { plays: unknown };
  assert.equal(out.plays, null);
  await assert.rejects(
    metrics.invoke(
      { operation: "posts.metrics", account: "mine", args: { postId: "999" } },
      account,
    ),
    /forbidden/,
  );
});
test("HTTP gate: auth, host, origin, strict scopes; failed upstream consumes quota", async () => {
  const store = new Store(":memory:");
  store.create(policy("test", 1), token);
  let calls = 0;
  const server = createGateway(
    config,
    store,
    new AdapterRegistry([
      Object.assign(new TikHub("FAKE_KEY"), {
        invoke: async () => {
          calls++;
          throw new Error("FAKE_KEY secret");
        },
      }),
    ]),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/invoke`;
  const send = (body: unknown = list, extra: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await send(list, { authorization: "bad" })).status, 401);
    assert.equal((await send(list, { origin: "https://evil" })).status, 403);
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        { method: "POST", headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHostStatus, 403);
    assert.equal(
      (
        await send({
          operation: "posts.metrics",
          account: "mine",
          args: { postId: "999" },
        })
      ).status,
      403,
    );
    assert.equal(calls, 0);
    const first = await send();
    assert.equal(first.status, 503);
    assert.ok(!(await first.text()).includes("FAKE_KEY"));
    assert.equal(calls, 1);
    assert.equal((await send()).status, 429);
    assert.equal(calls, 1);
    assert.equal(
      store.db.prepare("SELECT outcome FROM audit").get()!.outcome,
      "failed",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("malformed persisted policy and counters fail closed", () => {
  const store = new Store(":memory:");
  store.create(policy(), token);
  store.db.prepare("UPDATE grants SET policy=?").run(
    JSON.stringify({
      id: "test",
      accounts: ["mine"],
      operations: ["posts.list"],
    }),
  );
  assert.throws(
    () => store.reserve(token, "posts.list", "mine", 5, "corrupt"),
    /service_unavailable/,
  );
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM audit").get()!.n, 0);
  store.close();
});
test("provider registry supports another adapter without modifying policy core", async () => {
  const otherConfig = parseConfig({
    accounts: { local: { provider: "example", settings: {} } },
    globalDailyUnits: 3,
  });
  let calls = 0;
  const registry = new AdapterRegistry([
    {
      id: "example",
      operations: ["example.read"],
      validateAccount: () => {},
      validate: (input) => {
        assert.deepEqual(input.args, {});
      },
      invoke: async () => {
        calls++;
        return { value: "mock only" };
      },
    },
  ]);
  registry.validateConfig(otherConfig);
  assert.throws(
    () =>
      registry.resolve(
        { ...list, account: "local" },
        otherConfig.accounts.local!,
      ),
    /forbidden/,
  );
  const store = new Store(":memory:");
  store.create(
    { ...policy(), accounts: ["local"], operations: ["example.read"] },
    token,
  );
  const server = createGateway(otherConfig, store, registry);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        operation: "example.read",
        account: "local",
        args: {},
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.equal(store.db.prepare("SELECT used FROM grants").get()!.used, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("grant denies unapproved operation before upstream or quota use", () => {
  const store = new Store(":memory:");
  store.create({ ...policy(), operations: ["posts.list"] }, token);
  assert.throws(
    () => store.reserve(token, "posts.metrics", "mine", 5, "wrong-tool"),
    /forbidden/,
  );
  assert.equal(store.db.prepare("SELECT used FROM grants").get()!.used, 0);
  store.close();
});

test("unsafe exponential numeric IDs fail closed rather than rounding", async () => {
  const provider = new TikHub(
    "FAKE_KEY",
    async () =>
      new Response(
        '{"code":200,"data":{"aweme_list":[{"aweme_id":7.340000000000000001e18,"author":{"sec_uid":"mine-sec-uid"}}]}}',
      ),
  );
  await assert.rejects(provider.invoke(list, account), /upstream_unavailable/);
});

test("non-success provider body and HTTP redirects fail safely", async () => {
  for (const response of [
    new Response('{"code":500,"message":"FAKE_KEY"}'),
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.invalid" },
    }),
  ]) {
    const provider = new TikHub("FAKE_KEY", async () => response);
    await assert.rejects(
      provider.invoke(list, account),
      /^Error: upstream_unavailable$/,
    );
  }
});

test(
  "provider aborts a stalled request at its timeout",
  { timeout: 15_000 },
  async () => {
    let aborted = false;
    const provider = new TikHub(
      "FAKE_KEY",
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    await assert.rejects(
      provider.invoke(list, account),
      /upstream_unavailable/,
    );
    assert.equal(aborted, true);
  },
);
