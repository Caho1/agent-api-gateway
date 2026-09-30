import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { GatewayError, type Invocation, type Service } from "../src/model.ts";
import {
  canonicalPath,
  publicAddress,
  routeAllows,
  validRoutes,
  validateOrigin,
} from "../src/path-policy.ts";
import { Relay, type RelayDependencies } from "../src/relay.ts";

const secret = "FAKE_RELAY_SECRET_A/B+value=123456789";
const service: Service = {
  access: "routes",
  origin: "https://api.example.com",
  credential: { type: "header", name: "Authorization", prefix: "Bearer " },
  routes: [
    {
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      path: "/v1",
      match: "prefix",
    },
  ],
  allowedHeaders: ["accept", "content-type", "x-client"],
  timeoutMs: 500,
  maxRequestBytes: 1024,
  maxResponseBytes: 1024,
};
const invocation: Invocation = {
  service: "example",
  method: "GET",
  path: "/v1/items",
};
const publicDns = async () => [{ address: "93.184.215.14", family: 4 }];

type ReplyOptions = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  incomplete?: boolean;
  hang?: boolean;
  hangBody?: boolean;
};
function fakeTransport(
  body: Buffer = Buffer.from('{"ok":true}'),
  options: ReplyOptions = {},
) {
  const seen: {
    options?: RequestOptions;
    body?: Buffer;
    calls: number;
    destroyed: boolean;
  } = { calls: 0, destroyed: false };
  const request: NonNullable<RelayDependencies["request"]> = (
    requestOptions,
    callback,
  ) => {
    seen.options = requestOptions;
    seen.calls++;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => {
      seen.destroyed = true;
      return req;
    }) as ClientRequest["destroy"];
    req.end = ((requestBody?: Buffer) => {
      seen.body = requestBody;
      if (options.hang) return req;
      queueMicrotask(() => {
        const res = new PassThrough() as unknown as IncomingMessage;
        res.statusCode = options.status ?? 200;
        res.headers = options.headers ?? { "content-type": "application/json" };
        res.rawHeaders = Object.entries(res.headers).flatMap(
          ([name, value]) => [name, String(value)],
        );
        res.complete = !options.incomplete;
        callback(res);
        if (!res.destroyed) {
          for (const chunk of options.chunks ?? [body])
            (res as unknown as PassThrough).write(chunk);
          if (!options.hangBody) (res as unknown as PassThrough).end();
        }
      });
      return req;
    }) as ClientRequest["end"];
    requestOptions.signal?.addEventListener("abort", () => req.destroy());
    return req;
  };
  return { request, seen };
}
function harness(body?: Buffer, options?: ReplyOptions) {
  const transport = fakeTransport(body, options);
  return {
    relay: new Relay(() => secret, {
      resolve: publicDns,
      request: transport.request,
    }),
    ...transport,
  };
}
const upstreamError = (error: unknown) =>
  error instanceof GatewayError &&
  error.status === 502 &&
  error.code === "upstream_unavailable" &&
  !error.message.includes(secret);

test("origins reject URL ambiguity, private and reserved IPs and non-origins", () => {
  for (const origin of [
    "http://api.example.com",
    "https://user:pass@api.example.com",
    "https://@api.example.com",
    "https://api.example.com/v1",
    "https://api.example.com/.",
    "https://api.example.com?",
    "https://api.example.com#",
    "https://api.example.com\\@example.com",
    "https://api.example.com\n",
    "https://localhost",
    "https://metadata.internal",
    "https://127.0.0.1",
    "https://127.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://10.1.2.3",
    "https://100.64.0.1",
    "https://169.254.169.254",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://192.0.2.1",
    "https://198.18.0.1",
    "https://198.51.100.1",
    "https://203.0.113.1",
    "https://224.0.0.1",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[fc00::1]",
    "https://[fe80::1]",
    "https://[2001:db8::1]",
    "https://[2002:7f00:1::1]",
    "https://[3fff::1]",
  ])
    assert.throws(
      () => validateOrigin(origin),
      /Invalid service origin/,
      origin,
    );
  assert.equal(validateOrigin("https://api.example.com:8443/").port, "8443");
  assert.equal(validateOrigin("https://1.1.1.1").hostname, "1.1.1.1");
  assert.ok(publicAddress("2606:4700:4700::1111"));
  assert.ok(!publicAddress("not-an-ip"));
});

test("canonical paths reject normalization and traversal bypasses", () => {
  for (const path of [
    "https://evil.example/a",
    "//evil.example",
    "a",
    "/a\\b",
    "/a/../b",
    "/a/./b",
    "/a/%2e%2e/b",
    "/a/.%2E/b",
    "/a/%2f/b",
    "/a/%5C/b",
    "/a/%252e/b",
    "/a/%25/b",
    "/a//b",
    "/a?x=1",
    "/a#x",
    "/a/%3f",
    "/a/%00",
    "/a/%C2%85",
    "/a/..;/b",
    "/a b",
    "/a/%20b",
    "/a/%ff",
    "/a/%",
    "/a\n",
  ]) {
    assert.throws(() => canonicalPath(path), /Invalid path/, path);
  }
  assert.equal(
    canonicalPath("/%76%31/%E4%BD%A0%E5%A5%BD"),
    "/v1/%E4%BD%A0%E5%A5%BD",
  );
  assert.equal(canonicalPath("/v1/items/"), "/v1/items/");
  assert.ok(validRoutes([]));
  assert.ok(validRoutes(service.routes));
  assert.ok(
    !validRoutes([{ methods: ["GET"], path: "/%76%31", match: "prefix" }]),
  );
  assert.ok(
    !validRoutes([{ methods: ["GET", "GET"], path: "/v1", match: "prefix" }]),
  );
  assert.ok(!routeAllows(service.routes, "GET", "/v10/items"));
  assert.ok(!routeAllows([], "GET", "/v1/items"));
  assert.ok(routeAllows(service.routes, "GET", "/v1/items"));
  assert.ok(
    !routeAllows(
      [{ methods: ["POST"], path: "/v1", match: "exact" }],
      "GET",
      "/v1",
    ),
  );
});

test("validation is pure, rejects forbidden headers, collisions and malformed bodies", () => {
  let touched = false;
  const relay = new Relay(
    () => {
      touched = true;
      return secret;
    },
    {
      resolve: async () => {
        touched = true;
        return [];
      },
      request: () => {
        touched = true;
        throw new Error("network");
      },
    },
  );
  relay.validate(invocation, service);
  assert.equal(touched, false);
  for (const name of [
    "AUTHORIZATION",
    "Host",
    "Cookie",
    "Connection",
    "Content-Length",
    "Proxy-Authorization",
    "X-Forwarded-For",
    "Forwarded",
    "Via",
    "Expect",
    "X-Real-IP",
    "X-HTTP-Method-Override",
    "X-Original-URL",
    "Sec-Fetch-Site",
  ]) {
    assert.throws(
      () =>
        relay.validate(
          { ...invocation, headers: { [name]: "evil" } },
          { ...service, allowedHeaders: [name.toLowerCase()] },
        ),
      /invalid_request/,
      name,
    );
  }
  const invalidInputs: Invocation[] = [
    { ...invocation, headers: { Accept: "json", accept: "text" } },
    { ...invocation, headers: { accept: "ok\r\nevil: yes" } },
    { ...invocation, method: "POST" as const, body: {}, bodyBase64: "e30=" },
    { ...invocation, method: "POST" as const, bodyBase64: "!!!" },
    { ...invocation, method: "POST" as const, bodyBase64: "AB==" },
    { ...invocation, body: {} },
  ];
  for (const input of invalidInputs)
    assert.throws(() => relay.validate(input, service), /invalid_request/);
  assert.throws(
    () =>
      relay.validate(
        { ...invocation, headers: { "X-Api-Key": "evil" } },
        {
          ...service,
          credential: { type: "header", name: "x-api-key" },
          allowedHeaders: ["x-api-key"],
        },
      ),
    /invalid_request/,
  );
  for (const name of ["api_key", "API_KEY", "Api_Key"])
    assert.throws(
      () =>
        relay.validate(
          { ...invocation, query: { [name]: "evil" } },
          { ...service, credential: { type: "query", name: "api_key" } },
        ),
      /invalid_request/,
    );
  assert.equal(touched, false);
});

test("mixed A/AAAA results reject every nonpublic destination before transport", async () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ]) {
    const transport = fakeTransport();
    const relay = new Relay(() => secret, {
      request: transport.request,
      resolve: async () => [
        { address: "93.184.215.14", family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ],
    });
    await assert.rejects(relay.invoke(invocation, service), upstreamError);
    assert.equal(transport.seen.calls, 0);
  }
  for (const answers of [[], [{ address: "93.184.215.14", family: 6 }]]) {
    await assert.rejects(
      new Relay(() => secret, { resolve: async () => answers }).invoke(
        invocation,
        service,
      ),
      upstreamError,
    );
  }
});

test("actual native HTTPS socket lookup consumes the prevalidated pin only", async () => {
  let dnsCalls = 0;
  let lookedUp: unknown;
  let seenOptions: RequestOptions | undefined;
  const relay = new Relay(() => secret, {
    resolve: async () => {
      dnsCalls++;
      return [{ address: "93.184.215.14", family: 4 }];
    },
    request: (options, callback) => {
      seenOptions = options;
      return httpsRequest(
        {
          ...options,
          lookup: (hostname, lookupOptions, done) => {
            options.lookup!(
              hostname,
              lookupOptions,
              (error, address, family) => {
                assert.equal(error, null);
                lookedUp = { address, family };
                // Abort before a connection is attempted: this test sends no provider traffic.
                done(new Error("test stops after native socket lookup"), "", 4);
              },
            );
          },
        },
        callback,
      );
    },
  });
  await assert.rejects(relay.invoke(invocation, service), upstreamError);
  assert.equal(dnsCalls, 1);
  assert.deepEqual(lookedUp, { address: "93.184.215.14", family: 4 });
  assert.equal(seenOptions?.hostname, "api.example.com");
  assert.equal(seenOptions?.servername, "api.example.com");
  assert.equal(seenOptions?.rejectUnauthorized, true);
  assert.equal(seenOptions?.family, 4);
  assert.notEqual(seenOptions?.agent, undefined);
});

test("relay preserves JSON shape and raw bytes with large integers and benign metadata", async () => {
  const raw = Buffer.from(
    '{"code":200,"data":[{"id":7340000000000000001}],"extra":null}',
  );
  const { relay, seen } = harness(raw, {
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-123",
      "set-cookie": "sid=hidden",
      location: "https://elsewhere.example/",
    },
  });
  const result = await relay.invoke(
    {
      ...invocation,
      query: { tag: ["one", "two"], q: "hello world" },
      headers: { Accept: "application/json" },
    },
    service,
  );
  assert.equal(result.encoding, "json");
  assert.deepEqual(result.body, JSON.parse(raw.toString()));
  assert.equal(
    Buffer.from(result.rawBodyBase64!, "base64").toString(),
    raw.toString(),
  );
  assert.deepEqual(
    { ...result.headers },
    { "content-type": "application/json", "x-request-id": "request-123" },
  );
  assert.equal(seen.options?.path, "/v1/items?tag=one&tag=two&q=hello+world");
  assert.equal(
    (seen.options?.headers as Record<string, string>).authorization,
    "Bearer " + secret,
  );
  assert.equal(
    (seen.options?.headers as Record<string, string>)["accept-encoding"],
    "identity",
  );
});

test("JSON scalars, arrays and null are preserved, bytes and malformed JSON use base64", async () => {
  for (const value of [null, [1, "two"], "string", false, 123]) {
    const result = await harness(
      Buffer.from(JSON.stringify(value)),
    ).relay.invoke(invocation, service);
    assert.equal(result.encoding, "json");
    assert.deepEqual(result.body, value);
  }
  for (const raw of [
    Buffer.from([0, 255, 128, 1]),
    Buffer.from("invalid JSON"),
  ]) {
    const result = await harness(raw).relay.invoke(invocation, service);
    assert.equal(result.encoding, "base64");
    assert.equal(result.body, raw.toString("base64"));
    assert.equal(result.rawBodyBase64, undefined);
  }
});

test("generic body forwarding, no-credential services, and query injection preserve request data", async () => {
  const { relay, seen } = harness();
  await relay.invoke(
    { ...invocation, method: "POST", body: { nested: [1, true, null] } },
    service,
  );
  assert.equal(seen.body?.toString(), '{"nested":[1,true,null]}');
  assert.equal(
    (seen.options?.headers as Record<string, string>)["content-type"],
    "application/json",
  );
  const binary = Buffer.from([0, 255, 128, 1]);
  await relay.invoke(
    { ...invocation, method: "PUT", bodyBase64: binary.toString("base64") },
    { ...service, credential: { type: "query", name: "api_key" } },
  );
  assert.deepEqual(seen.body, binary);
  assert.equal(
    new URL("https://api.example.com" + seen.options?.path).searchParams.get(
      "api_key",
    ),
    secret,
  );
  const noKey = new Relay(
    () => {
      throw new Error("key must not be read");
    },
    { resolve: publicDns, request: fakeTransport().request },
  );
  await noKey.invoke(invocation, { ...service, credential: { type: "none" } });
});

test("redirects are rejected without following or returning redirect metadata", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { relay, seen } = harness(Buffer.from("redirect"), {
      status,
      headers: { location: "https://127.0.0.1/" },
    });
    await assert.rejects(relay.invoke(invocation, service), upstreamError);
    assert.equal(seen.calls, 1);
    assert.ok(seen.destroyed);
  }
});

test("credential echoes are rejected in body and headers, including URL, base64 and JSON escapes", async () => {
  const forms = [
    secret,
    "Bearer " + secret,
    encodeURIComponent(secret),
    [...Buffer.from(secret)].map((byte) => "%" + byte.toString(16)).join(""),
    Buffer.from(secret).toString("base64"),
    Buffer.from("prefix " + secret + " suffix").toString("base64"),
    Buffer.from(secret).toString("base64url"),
    secret
      .split("")
      .map((char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))
      .join(""),
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(Buffer.from(secret).toString("base64")),
  ];
  for (const form of forms) {
    await assert.rejects(
      harness(Buffer.from('{"echo":"' + form + '"}')).relay.invoke(
        invocation,
        service,
      ),
      upstreamError,
    );
    await assert.rejects(
      harness(undefined, {
        headers: { "content-type": "application/json", "x-request-id": form },
      }).relay.invoke(invocation, service),
      upstreamError,
    );
  }
  for (const bytes of [
    Buffer.from(secret, "utf16le"),
    Buffer.from(secret, "utf16le").swap16(),
  ]) {
    await assert.rejects(
      harness(bytes).relay.invoke(invocation, service),
      upstreamError,
    );
    await assert.rejects(
      harness(Buffer.from(bytes.toString("base64"))).relay.invoke(
        invocation,
        service,
      ),
      upstreamError,
    );
  }
  // Even an otherwise dropped header cannot accidentally carry a key through later changes.
  await assert.rejects(
    harness(undefined, { headers: { "set-cookie": secret } }).relay.invoke(
      invocation,
      service,
    ),
    upstreamError,
  );
});

test("request and response limits, compression and incomplete responses fail closed", async () => {
  const { relay, seen } = harness();
  assert.throws(
    () =>
      relay.validate(
        { ...invocation, method: "POST", body: "x".repeat(1024) },
        service,
      ),
    /request_too_large/,
  );
  assert.throws(
    () =>
      relay.validate(
        {
          ...invocation,
          method: "POST",
          bodyBase64: Buffer.alloc(1025).toString("base64"),
        },
        service,
      ),
    /request_too_large/,
  );
  assert.throws(
    () =>
      relay.validate(
        { ...invocation, query: { q: "x".repeat(17000) } },
        service,
      ),
    /request_too_large/,
  );
  assert.equal(seen.calls, 0);
  const invalidReplies: ReplyOptions[] = [
    { chunks: [Buffer.alloc(600), Buffer.alloc(600)] },
    { headers: { "content-length": "1025" } },
    { headers: { "content-encoding": "gzip" } },
    { incomplete: true },
  ];
  for (const options of invalidReplies)
    await assert.rejects(
      harness(undefined, options).relay.invoke(invocation, service),
      upstreamError,
    );
});

test("one deadline includes DNS, connection and body waiting; errors are sanitized", async () => {
  const fast = { ...service, timeoutMs: 25 };
  let called = false;
  const dnsTimeout = new Relay(() => secret, {
    resolve: () => new Promise(() => {}),
    request: () => {
      called = true;
      throw new Error(secret);
    },
  });
  await assert.rejects(
    dnsTimeout.invoke(invocation, fast),
    (error: unknown) =>
      error instanceof GatewayError &&
      error.status === 504 &&
      error.code === "upstream_timeout",
  );
  assert.equal(called, false);
  const hanging = harness(undefined, { hang: true });
  await assert.rejects(
    hanging.relay.invoke(invocation, fast),
    /upstream_timeout/,
  );
  assert.ok(hanging.seen.destroyed);
  const slowBody = harness(undefined, { hangBody: true });
  await assert.rejects(
    slowBody.relay.invoke(invocation, fast),
    /upstream_timeout/,
  );
  assert.ok(slowBody.seen.destroyed);
  const failure = new Relay(() => secret, {
    resolve: publicDns,
    request: () => {
      throw new Error("secret error: " + secret);
    },
  });
  await assert.rejects(failure.invoke(invocation, service), upstreamError);
});

test("query credential form-encoding echoes, including mixed plus and percent, are blocked", async () => {
  const key = "FAKE SPACE SECRET 12345";
  const queryService: Service = {
    ...service,
    credential: { type: "query", name: "token" },
  };
  const exactForm = new URLSearchParams({ token: key }).toString();
  for (const echo of [
    exactForm,
    "token=FAKE+SPACE%20SECRET+12345",
    "token=%46AKE%20SPACE+SECRET%2012345",
  ]) {
    for (const headerEcho of [false, true]) {
      const transport = fakeTransport(
        Buffer.from(headerEcho ? "{}" : echo),
        headerEcho
          ? {
              headers: {
                "content-type": "application/json",
                "x-request-id": echo,
              },
            }
          : {},
      );
      const relay = new Relay(() => key, {
        resolve: publicDns,
        request: transport.request,
      });
      await assert.rejects(
        relay.invoke(invocation, queryService),
        upstreamError,
      );
      assert.equal(transport.seen.options?.path, "/v1/items?" + exactForm);
    }
  }
});

test("an in-flight DNS lookup retains its original origin and credential across rotation", async () => {
  for (const echoOldKey of [false, true]) {
    const oldKey = "OLD_FAKE_KEY_FOR_OLD_ORIGIN";
    let currentKey = oldKey;
    let keyReads = 0;
    let releaseDns!: (addresses: { address: string; family: number }[]) => void;
    let registeredService = { ...service, origin: "https://old.example.com" };
    const transport = fakeTransport(
      Buffer.from(echoOldKey ? JSON.stringify({ echo: oldKey }) : "{}"),
    );
    const relay = new Relay(
      () => {
        keyReads++;
        return currentKey;
      },
      {
        resolve: () =>
          new Promise((resolve) => {
            releaseDns = resolve;
          }),
        request: transport.request,
      },
    );
    const result = relay.invoke(invocation, registeredService);
    assert.equal(
      keyReads,
      1,
      "credential is captured synchronously before DNS suspends",
    );
    currentKey = "NEW_FAKE_KEY_FOR_NEW_ORIGIN";
    registeredService = {
      ...registeredService,
      origin: "https://new.example.com",
    };
    releaseDns(await publicDns());
    if (echoOldKey) await assert.rejects(result, upstreamError);
    else await result;
    assert.equal(keyReads, 1);
    assert.equal(transport.seen.options?.hostname, "old.example.com");
    assert.equal(
      (transport.seen.options?.headers as Record<string, string>).authorization,
      "Bearer " + oldKey,
    );
    assert.equal(registeredService.origin, "https://new.example.com");
  }
});

test("deep valid JSON falls back to exact bytes when its envelope cannot serialize", async () => {
  const raw = Buffer.from("[".repeat(10000) + "0" + "]".repeat(10000));
  assert.doesNotThrow(() => JSON.parse(raw.toString()));
  const { relay } = harness(raw);
  const result = await relay.invoke(invocation, {
    ...service,
    maxResponseBytes: raw.length,
  });
  assert.equal(result.encoding, "base64");
  assert.equal(result.body, raw.toString("base64"));
  assert.doesNotThrow(() => JSON.stringify({ response: result }));
});
