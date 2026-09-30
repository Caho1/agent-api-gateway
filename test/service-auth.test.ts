import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseConfig,
  parseService,
  type Invocation,
  type Route,
} from "../src/model.ts";
import { Relay } from "../src/relay.ts";
import { Store, validGrant, type Grant } from "../src/store.ts";
import { createGateway } from "../src/app.ts";
const token = "FAKE_SERVICE_AUTH_TEST_TOKEN_01234567890123456789";
const routes: Route[] = [{ methods: ["GET"], match: "exact", path: "/v1/old" }];
const policy = (id = "service-agent"): Grant => ({
  schemaVersion: 3,
  id,
  services: ["upstream"],
  expiresAt: Date.now() + 60000,
  dailyUnits: 20,
  totalUnits: 30,
  perMinute: 20,
});
test("new service definitions require no route/method policy and persist their explicit access mode", () => {
  const service = parseService({ origin: "https://api.example.com" });
  assert.equal(service.access, "service");
  assert.equal(Object.hasOwn(service, "routes"), false);
  const reloaded = parseConfig({
    schemaVersion: 2,
    globalDailyUnits: 100,
    services: { upstream: service },
  });
  assert.deepEqual(reloaded.services.upstream, service);
  const relay = new Relay(() => "");
  for (const method of [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ] as const)
    relay.validate(
      { service: "upstream", method, path: "/any/upstream/api/v99" },
      service,
    );
  assert.throws(() =>
    relay.validate(
      { service: "upstream", method: "GET", path: "https://other.example.com" },
      service,
    ),
  );
  assert.throws(() =>
    relay.validate(
      {
        service: "upstream",
        method: "GET",
        path: "/any",
        headers: { host: "evil.example.com" },
      },
      service,
    ),
  );
});
test("old persisted services retain explicit restrictions and omitted routes remain deny-all", () => {
  const config = parseConfig({
    schemaVersion: 2,
    globalDailyUnits: 100,
    services: {
      explicit: { origin: "https://api.example.com", routes },
      omitted: { origin: "https://api.example.com" },
    },
  });
  const relay = new Relay(() => "");
  assert.equal(config.services.explicit!.access, "routes");
  assert.deepEqual(config.services.omitted!.routes, []);
  relay.validate(
    { service: "explicit", method: "GET", path: "/v1/old" },
    config.services.explicit!,
  );
  assert.throws(
    () =>
      relay.validate(
        { service: "explicit", method: "DELETE", path: "/v1/old" },
        config.services.explicit!,
      ),
    /forbidden/,
  );
  assert.throws(
    () =>
      relay.validate(
        { service: "omitted", method: "GET", path: "/v1/old" },
        config.services.omitted!,
      ),
    /forbidden/,
  );
  assert.throws(
    () =>
      parseService({
        origin: "https://api.example.com",
        access: "service",
        routes: [],
      }),
    /cannot contain routes/,
  );
});
test("v3 grants authenticate whole services; v2 grants never gain new path or method rights", () => {
  const store = new Store(":memory:");
  try {
    assert.ok(validGrant(policy()));
    assert.equal(validGrant({ ...policy(), routes: [] }), false);
    assert.equal(validGrant({ ...policy(), schemaVersion: 2 }), false);
    store.create(policy(), token);
    store.reserve(
      token,
      { service: "upstream", method: "DELETE", path: "/anything/new" },
      100,
      "full",
    );
    assert.throws(
      () =>
        store.reserve(
          token,
          { service: "different", method: "GET", path: "/anything" },
          100,
          "wrong-service",
        ),
      /forbidden/,
    );
    const old = { ...policy("old"), schemaVersion: 2 as const, routes };
    store.create(old, token + "2");
    store.reserve(
      token + "2",
      { service: "upstream", method: "GET", path: "/v1/old" },
      100,
      "old-allowed",
    );
    assert.throws(
      () =>
        store.reserve(
          token + "2",
          { service: "upstream", method: "POST", path: "/v1/old" },
          100,
          "old-method",
        ),
      /forbidden/,
    );
    assert.throws(
      () =>
        store.reserve(
          token + "2",
          { service: "upstream", method: "GET", path: "/elsewhere" },
          100,
          "old-path",
        ),
      /forbidden/,
    );
    assert.equal(
      store.summary().grants.find((g) => g.id === "old")!.restricted,
      true,
    );
    assert.equal(
      store.summary().grants.find((g) => g.id === "service-agent")!.restricted,
      false,
    );
  } finally {
    store.close();
  }
});
test("gateway requires service authentication but no route setup; new grant cannot bypass an old service", async () => {
  const config = parseConfig({
    schemaVersion: 2,
    globalDailyUnits: 100,
    services: {
      upstream: parseService({ origin: "https://api.example.com" }),
      legacy: { origin: "https://api.example.com", routes },
    },
  });
  const store = new Store(":memory:");
  store.create({ ...policy(), services: ["upstream", "legacy"] }, token);
  const validator = new Relay(() => "");
  let calls = 0;
  const server = createGateway(config, store, {
    validate: (input, service) => validator.validate(input, service),
    invoke: async (input) => {
      calls++;
      return {
        status: 200,
        headers: {},
        encoding: "json",
        body: {
          method: input.method,
          path: input.path,
          query: input.query,
          body: input.body,
        },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const send = (input: Invocation, auth = true) =>
    fetch("http://127.0.0.1:" + address.port + "/v1/relay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(input),
    });
  try {
    const input: Invocation = {
      service: "upstream",
      method: "POST",
      path: "/original/upstream/path",
      query: { original: "unchanged" },
      body: { arbitrary: true },
    };
    assert.equal((await send(input, false)).status, 401);
    const result = await send(input);
    assert.equal(result.status, 200);
    assert.deepEqual(
      ((await result.json()) as { data: { body: unknown } }).data.body,
      {
        method: input.method,
        path: input.path,
        query: input.query,
        body: input.body,
      },
    );
    assert.equal(
      (
        await send({
          service: "upstream",
          method: "DELETE",
          path: "/previously-unconfigured",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await send({
          service: "legacy",
          method: "DELETE",
          path: "/previously-unconfigured",
        })
      ).status,
      403,
    );
    assert.equal(
      (await send({ service: "other", method: "GET", path: "/whatever" }))
        .status,
      403,
    );
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
