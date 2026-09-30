test("expired sessions fail closed", async (t) => {
  const auth = new AdminAuth({ hash: await passwordHash(password) });
  const session = await auth.login(password);
  t.mock.timers.enable({ apis: ["Date"], now: session.expiresAt + 1 });
  try {
    assert.throws(
      () => auth.session("gateway_admin=" + session.token),
      /admin_unauthorized/,
    );
  } finally {
    t.mock.timers.reset();
  }
});
test("connection file failure cannot resurrect a live grant", async () => {
  const f = await fixture();
  try {
    const session = await f.login(),
      headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    await f.send("/admin/api/connections", { id: "mine", ...service }, headers);
    const grant = {
      id: "agent",
      schemaVersion: 2,
      services: ["mine"],
      routes,
      perMinute: 10,
      expiresAt: Date.now() + 60_000,
      dailyUnits: 2,
      totalUnits: 4,
    };
    const { token } = (await (
      await f.send("/admin/api/grants", grant, headers)
    ).json()) as { token: string };
    rmSync(join(f.directory, "config.json"));
    mkdirSync(join(f.directory, "config.json"));
    assert.equal(
      (await f.send("/admin/api/connections/delete", { id: "mine" }, headers))
        .status,
      503,
    );
    assert.throws(
      () => f.store.reserve(token, input, 100, "after-file-failure"),
      /unauthorized/,
    );
  } finally {
    await f.close();
  }
});
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminAuth, passwordHash } from "../src/admin-auth.ts";
import { Admin } from "../src/admin.ts";
import { Settings } from "../src/settings.ts";
import { Relay } from "../src/relay.ts";
import { Store } from "../src/store.ts";
import { createGateway } from "../src/app.ts";
import {
  parseConfig,
  parseService,
  type Invocation,
  type Route,
} from "../src/model.ts";
const password = "FAKE_LOCAL_TEST_PASSWORD_123";
const secret = "FAKE_PROVIDER_TEST_KEY_123456789";
const routes: Route[] = [{ methods: ["GET"], match: "prefix", path: "/v1" }];
const service = parseService({
  origin: "https://api.example.com",
  credential: { type: "header", name: "Authorization", prefix: "Bearer " },
  routes,
});
const input: Invocation = { service: "mine", method: "GET", path: "/v1/items" };
const origin = "http://127.0.0.1:8787";
async function fixture(configured = true, publicOrigin = origin) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-admin-"));
  const config = parseConfig({
    schemaVersion: 2,
    services: {},
    globalDailyUnits: 100,
  });
  const relay = new Relay(() => secret);
  const settings = new Settings(
    config,
    join(directory, "config.json"),
    join(directory, "keys.json"),
  );
  const store = new Store(join(directory, "gateway.sqlite"));
  const auth = new AdminAuth(
    configured ? { hash: await passwordHash(password) } : undefined,
  );
  const admin = new Admin(auth, settings, store, publicOrigin);
  const server = createGateway(config, store, relay, admin);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const send = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", origin: publicOrigin }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async () => {
    const response = await send("/admin/api/login", { password });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      ...((await response.json()) as { csrf: string }),
    };
  };
  return {
    directory,
    config,
    settings,
    store,
    auth,
    send,
    login,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("uninitialized admin is locked; static shell safe; no public bootstrap", async () => {
  const f = await fixture(false);
  try {
    assert.deepEqual(await (await f.send("/admin/api/status")).json(), {
      configured: false,
    });
    assert.equal((await f.send("/admin/api/state")).status, 401);
    assert.equal((await f.send("/admin/api/login", { password })).status, 503);
    assert.equal((await f.send("/admin/api/setup", { password })).status, 401);
    const page = await f.send("/admin");
    assert.equal(page.status, 200);
    assert.ok(
      page.headers
        .get("content-security-policy")!
        .includes("frame-ancestors 'none'"),
    );
    assert.ok(
      page.headers
        .get("content-security-policy")!
        .includes("script-src 'self'"),
    );
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal((await f.send("/admin/../state/keys.json")).status, 404);
    assert.equal((await f.send("/healthz")).status, 200);
    assert.equal(f.store.summary().grants.length, 0);
  } finally {
    await f.close();
  }
});
test("admin auth, exact origin, CSRF, secure cookie, rotation and logout", async () => {
  const f = await fixture(true, "https://129.204.35.13");
  try {
    assert.equal(
      (
        await f.send(
          "/admin/api/login",
          { password },
          { origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.send("/admin/api/login", { password }, { origin: "" })).status,
      403,
    );
    assert.equal(
      (await f.send("/admin/api/login", { password: "wrong" })).status,
      401,
    );
    const first = await f.send("/admin/api/login", { password });
    const cookie = first.headers.get("set-cookie")!;
    assert.ok(
      cookie.includes("HttpOnly") &&
        cookie.includes("SameSite=Strict") &&
        cookie.includes("; Secure"),
    );
    const session = (await first.json()) as { csrf: string };
    const headers = { cookie: cookie.split(";")[0]! };
    assert.equal(
      (await f.send("/admin/api/state", undefined, headers)).status,
      200,
    );
    assert.equal(
      (
        await f.send("/admin/api/state", undefined, {
          ...headers,
          origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.send("/admin/api/quota", { globalDailyUnits: 2 }, headers))
        .status,
      403,
    );
    assert.equal(
      (
        await f.send(
          "/admin/api/quota",
          { globalDailyUnits: 2 },
          { ...headers, "x-csrf-token": "wrong" },
        )
      ).status,
      403,
    );
    assert.equal(f.config.globalDailyUnits, 100);
    assert.equal(
      (
        await f.send(
          "/admin/api/quota",
          { globalDailyUnits: 2 },
          { ...headers, "x-csrf-token": "é".repeat(43) },
        )
      ).status,
      403,
    );
    const rotated = await f.send("/admin/api/login", { password }, headers);
    assert.equal(rotated.status, 200);
    assert.notEqual(
      rotated.headers.get("set-cookie")!.split(";")[0],
      headers.cookie,
    );
    assert.equal(
      (await f.send("/admin/api/state", undefined, headers)).status,
      401,
    );
    const rotatedData = (await rotated.json()) as { csrf: string };
    headers.cookie = rotated.headers.get("set-cookie")!.split(";")[0]!;
    session.csrf = rotatedData.csrf;
    const second = await f.login();
    assert.notEqual(second.cookie, headers.cookie);
    assert.notEqual(second.csrf, session.csrf);
    assert.equal(
      (
        await f.send(
          "/admin/api/logout",
          {},
          { ...headers, "x-csrf-token": session.csrf },
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.send("/admin/api/state", undefined, headers)).status,
      401,
    );
    assert.equal(
      (await f.send("/admin/api/state", undefined, { cookie: second.cookie }))
        .status,
      200,
    );
  } finally {
    await f.close();
  }
});
test("password verification is throttled and malformed hash or unsafe public origin fails closed", async () => {
  const auth = new AdminAuth({ hash: await passwordHash(password) });
  for (let i = 0; i < 5; i++)
    await assert.rejects(auth.login("wrong"), /invalid_credentials/);
  await assert.rejects(auth.login(password), /try_later/);
  assert.throws(() => new AdminAuth({ hash: "bad" }), /Invalid admin hash/);
  const f = await fixture();
  try {
    assert.throws(
      () => new Admin(f.auth, f.settings, f.store, "http://129.204.35.13"),
      /Admin requires/,
    );
    const session = await f.auth.login(password);
    assert.throws(
      () => f.auth.session("gateway_admin=" + session.token + "bad"),
      /admin_unauthorized/,
    );
    f.auth.logout(session.token);
    assert.throws(
      () => f.auth.session("gateway_admin=" + session.token),
      /admin_unauthorized/,
    );
  } finally {
    await f.close();
  }
});
test("connections are write-only; state, audit and errors exclude keys and tokens", async () => {
  const f = await fixture();
  try {
    const session = await f.login();
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const body = {
      id: "mine",
      ...service,
      apiKey: secret,
    };
    assert.equal((await f.send("/admin/api/connections", body)).status, 401);
    assert.equal(
      (await f.send("/admin/api/connections", body, headers)).status,
      200,
    );
    assert.equal(f.settings.key("mine"), secret);
    assert.equal(statSync(join(f.directory, "keys.json")).mode & 0o777, 0o600);
    const state = await (
      await f.send("/admin/api/state", undefined, { cookie: session.cookie })
    ).text();
    assert.ok(!state.includes(secret));
    assert.ok(!state.includes(session.cookie.split("=")[1]!));
    assert.ok(!state.includes("token_hash"));
    assert.ok(state.includes('"credentialConfigured":true'));
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, "config.json"), "utf8"))
        .services.mine,
      service,
    );
    assert.ok(
      !readFileSync(join(f.directory, "config.json"), "utf8").includes(secret),
    );
    const errors = await (
      await f.send(
        "/admin/api/connections",
        { ...body, provider: "https://evil", apiKey: secret },
        headers,
      )
    ).text();
    assert.ok(!errors.includes(secret));
    assert.ok(errors.includes("invalid_connection"));
    assert.equal(
      (
        await f.send(
          "/admin/api/connections",
          { ...body, apiKey: undefined, timeoutMs: 5000 },
          headers,
        )
      ).status,
      200,
    );
    assert.equal(f.settings.key("mine"), secret);
    assert.deepEqual(f.settings.redact({ detail: secret + " echo" }), {
      detail: "[REDACTED] echo",
    });
  } finally {
    await f.close();
  }
});
test("grant scope, repeated IDs, quota projection, revocation and deleted connection fail closed", async () => {
  const f = await fixture();
  try {
    const session = await f.login();
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    await f.send("/admin/api/connections", { id: "mine", ...service }, headers);
    const grant = {
      id: "agent",
      schemaVersion: 2,
      services: ["mine"],
      routes,
      perMinute: 10,
      expiresAt: Date.now() + 60_000,
      dailyUnits: 2,
      totalUnits: 4,
    };
    assert.equal(
      (
        await f.send(
          "/admin/api/grants",
          { ...grant, operations: ["delete"] },
          headers,
        )
      ).status,
      400,
    );
    const response = await f.send("/admin/api/grants", grant, headers);
    assert.equal(response.status, 201);
    const { token } = (await response.json()) as { token: string };
    assert.equal(
      (await f.send("/admin/api/grants", grant, headers)).status,
      409,
    );
    f.store.reserve(token, input, 100, "one");
    f.store.finish("one", true);
    const snapshot = (await (
      await f.send("/admin/api/state", undefined, { cookie: session.cookie })
    ).json()) as {
      globalUsed: number;
      grants: { used: number; dailyUsed: number }[];
    };
    assert.equal(snapshot.globalUsed, 1);
    assert.equal(snapshot.grants[0]!.used, 1);
    assert.equal(snapshot.grants[0]!.dailyUsed, 1);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await f.send("/admin/api/grants/revoke", { id: "agent" }, headers))
          .status,
        200,
      );
    assert.throws(
      () => f.store.reserve(token, input, 100, "revoked"),
      /unauthorized/,
    );
    assert.equal(
      (await f.send("/admin/api/grants", grant, headers)).status,
      409,
    );
    const next = { ...grant, id: "another" };
    const other = (await (
      await f.send("/admin/api/grants", next, headers)
    ).json()) as { token: string };
    await f.send("/admin/api/connections/delete", { id: "mine" }, headers);
    await f.send("/admin/api/connections", { id: "mine", ...service }, headers);
    assert.throws(
      () => f.store.reserve(other.token, input, 100, "resurrect"),
      /unauthorized/,
    );
    const state = await (
      await f.send("/admin/api/state", undefined, { cookie: session.cookie })
    ).text();
    assert.ok(!state.includes(token));
    assert.ok(!state.includes(other.token));
  } finally {
    await f.close();
  }
});
test("private settings reload preserves identity and accepts only generic service fields", async () => {
  const f = await fixture();
  try {
    f.settings.saveConnection({
      id: "mine",
      ...service,
      apiKey: secret,
    });
    const reloaded = new Settings(
      f.config,
      join(f.directory, "config.json"),
      join(f.directory, "keys.json"),
    );
    assert.equal(reloaded.key("mine"), secret);
    assert.throws(
      () =>
        reloaded.saveConnection({
          id: "mine",
          ...service,
          url: "https://evil",
        }),
      /invalid_connection/,
    );
  } finally {
    await f.close();
  }
});

test("failed origin/key update cannot pair new key with old origin after restart", async () => {
  const f = await fixture();
  try {
    f.settings.saveConnection({ id: "mine", ...service, apiKey: secret });
    const before = readFileSync(join(f.directory, "config.json"), "utf8");
    rmSync(join(f.directory, "config.json"));
    mkdirSync(join(f.directory, "config.json"));
    assert.throws(() =>
      f.settings.saveConnection({
        id: "mine",
        ...service,
        origin: "https://new-provider.example.com",
        apiKey: "FAKE_NEW_PROVIDER_KEY_12345",
      }),
    );
    assert.equal(f.config.services.mine!.origin, service.origin);
    assert.equal(f.settings.key("mine"), secret);
    rmSync(join(f.directory, "config.json"), { recursive: true });
    writeFileSync(join(f.directory, "config.json"), before, { mode: 0o600 });
    const reloaded = new Settings(
      parseConfig(JSON.parse(before)),
      join(f.directory, "config.json"),
      join(f.directory, "keys.json"),
    );
    assert.equal(reloaded.key("mine"), secret);
    reloaded.saveConnection({
      id: "mine",
      ...service,
      origin: "https://different-provider.example.com",
    });
    assert.equal(reloaded.key("mine"), "");
  } finally {
    await f.close();
  }
});
test("legacy provider keys are preserved but never implicitly injected into generic services", async () => {
  const f = await fixture();
  try {
    writeFileSync(
      join(f.directory, "keys.json"),
      JSON.stringify({ mine: secret }),
    );
    const legacy = parseConfig({
      accounts: {
        mine: { provider: "tikhub", settings: { secUid: "legacy" } },
      },
      globalDailyUnits: 100,
    });
    const settings = new Settings(
      legacy,
      join(f.directory, "config.json"),
      join(f.directory, "keys.json"),
      secret,
    );
    settings.saveConnection({ id: "mine", ...service });
    assert.equal(settings.key("mine"), "");
    assert.equal(
      JSON.parse(readFileSync(join(f.directory, "keys.json"), "utf8")).mine,
      secret,
    );
    settings.saveConnection({ id: "mine", ...service, apiKey: secret });
    assert.equal(settings.key("mine"), secret);
  } finally {
    await f.close();
  }
});
