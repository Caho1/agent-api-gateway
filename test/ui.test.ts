import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const html = readFileSync(
  new URL("../web/admin.html", import.meta.url),
  "utf8",
);
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
async function fixture() {
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8787/admin",
    runScripts: "outside-only",
  });
  const { window: w } = dom;
  let loggedIn = false;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const connections: Record<string, unknown>[] = [];
  const snapshot = () => ({
    csrf: "FAKE_CSRF",
    expiresAt: Date.now() + 60000,
    connections,
    grants: [],
    audit: [],
    adminAudit: [],
    globalUsed: 0,
    globalDailyUnits: 100,
    day: "2026-09-30",
    migrationRequired: [],
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  w.confirm = () => true;
  w.fetch = (async (url: string, options?: RequestInit) => {
    const path = String(url).split("/").at(-1)!;
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    calls.push({ path, body });
    let result: unknown = { ok: true },
      status = 200;
    if (path === "status") result = { configured: true };
    else if (path === "login") {
      loggedIn = true;
      result = { csrf: "FAKE_CSRF" };
    } else if (path === "logout") loggedIn = false;
    else if (path === "state") {
      if (loggedIn) result = snapshot();
      else {
        status = 401;
        result = { error: "admin_unauthorized" };
      }
    } else if (path === "grants") {
      result = { token: "FAKE_DISPOSABLE_UI_TOKEN" };
    } else if (path === "upgrade") {
      const service = connections.find((x) => x.id === body.id);
      if (service) {
        service.access = "service";
        delete service.routes;
      }
    } else if (path === "connections") {
      connections.push({
        ...body,
        access: "service",
        credentialConfigured: false,
      });
    }
    return new Response(JSON.stringify(result), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await w.eval("(async()=>{" + source + "})()");
  const settle = async () => {
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const submit = async (id: string) => {
    w.document
      .querySelector(id)!
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    await settle();
  };
  const input = (name: string) =>
    w.document.querySelector<HTMLInputElement>(
      `#connection-form [name="${name}"]`,
    )!;
  const login = async () => {
    w.document.querySelector<HTMLInputElement>("#password")!.value =
      "FAKE_LOCAL_TEST_PASSWORD_123";
    await submit("#login-form");
  };
  return {
    dom,
    w,
    calls,
    connections,
    settle,
    submit,
    input,
    login,
    close: () => dom.window.close(),
  };
}
test("generic management UI login, service form, navigation, cancel and logout", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.w.document.querySelector<HTMLElement>("#console")!.hidden,
      true,
    );
    await f.login();
    assert.equal(
      f.w.document.querySelector<HTMLElement>("#console")!.hidden,
      false,
    );
    f.w.document
      .querySelector<HTMLButtonElement>('[data-view="connections"]')!
      .click();
    f.w.document.querySelector<HTMLButtonElement>("#add-connection")!.click();
    assert.ok(f.w.document.querySelector("#connection-dialog[open]"));
    f.input("id").value = "example";
    f.input("origin").value = "https://api.example.com";
    await f.submit("#connection-form");
    const saved = f.calls.find((x) => x.path === "connections")!;
    assert.equal(Object.hasOwn(saved.body, "routes"), false);
    assert.equal(f.w.document.querySelector('[name="routes"]'), null);
    assert.equal(saved.body.origin, "https://api.example.com");
    assert.ok(!Object.hasOwn(saved.body, "postIds"));
    assert.equal(f.w.document.querySelector("#connection-dialog[open]"), null);
    assert.ok(
      f.w.document
        .querySelector("#connection-list")!
        .textContent!.includes("https://api.example.com"),
    );
    f.w.document.querySelector<HTMLButtonElement>("#add-connection")!.click();
    f.input("apiKey").value = "FAKE_KEY_FOR_UI_TEST";
    f.w.document
      .querySelector<HTMLButtonElement>("#connection-dialog [data-close]")!
      .click();
    assert.equal(f.input("apiKey").value, "");
    f.w.document.querySelector<HTMLButtonElement>("#add-grant")!.click();
    assert.ok(f.w.document.querySelector("#grant-dialog[open]"));
    f.w.document
      .querySelector<HTMLButtonElement>("#grant-dialog [data-close]")!
      .click();
    assert.equal(f.w.document.querySelector("#grant-dialog[open]"), null);
    f.w.document.querySelector<HTMLButtonElement>("#logout")!.click();
    await f.settle();
    assert.equal(
      f.w.document.querySelector<HTMLElement>("#console")!.hidden,
      true,
    );
    assert.equal(
      f.w.document.querySelector<HTMLInputElement>("#password")!.value,
      "",
    );
  } finally {
    f.close();
  }
});
test("repeated service submit is ignored while the first request is pending", async () => {
  const f = await fixture();
  try {
    await f.login();
    f.w.document.querySelector<HTMLButtonElement>("#add-connection")!.click();
    f.input("id").value = "example";
    f.input("origin").value = "https://api.example.com";
    const original = f.w.fetch;
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saves = 0;
    f.w.fetch = (async (url: string, options?: RequestInit) => {
      if (String(url).endsWith("/connections")) {
        saves++;
        await pending;
      }
      return original(url, options);
    }) as typeof fetch;
    const form = f.w.document.querySelector("#connection-form")!;
    form.dispatchEvent(
      new f.w.Event("submit", { bubbles: true, cancelable: true }),
    );
    assert.equal(
      f.w.document.querySelector<HTMLButtonElement>(
        '#connection-form [type="submit"]',
      )!.disabled,
      true,
    );
    form.dispatchEvent(
      new f.w.Event("submit", { bubbles: true, cancelable: true }),
    );
    assert.equal(saves, 1);
    release();
    await f.settle();
    assert.equal(f.calls.filter((x) => x.path === "connections").length, 1);
  } finally {
    f.close();
  }
});

test("new grant form selects services without route or method configuration", async () => {
  const f = await fixture();
  try {
    f.connections.push({
      id: "example",
      origin: "https://api.example.com",
      access: "service",
      credential: { type: "none" },
      allowedHeaders: ["accept"],
      timeoutMs: 1000,
      maxRequestBytes: 1000,
      maxResponseBytes: 1000,
      credentialConfigured: true,
    });
    await f.login();
    f.w.document.querySelector<HTMLButtonElement>("#add-grant")!.click();
    const form = f.w.document.querySelector<HTMLFormElement>("#grant-form")!;
    assert.equal(form.querySelector('[name="routes"]'), null);
    assert.equal(form.querySelector('[name="methods"]'), null);
    (form.elements.namedItem("id") as HTMLInputElement).value = "new-agent";
    form.querySelector<HTMLInputElement>('[name="services"]')!.checked = true;
    await f.submit("#grant-form");
    const saved = f.calls.find((x) => x.path === "grants")!;
    assert.equal(saved.body.schemaVersion, 3);
    assert.deepEqual(saved.body.services, ["example"]);
    assert.equal(Object.hasOwn(saved.body, "routes"), false);
    assert.ok(f.w.document.querySelector("#token-dialog[open]"));
    f.w.document
      .querySelector<HTMLButtonElement>("#token-dialog [data-close]")!
      .click();
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>("#new-token")!.value,
      "",
    );
  } finally {
    f.close();
  }
});
test("legacy service conversion is explicit, cancelable and explains token revocation", async () => {
  const f = await fixture();
  try {
    f.connections.push({
      id: "legacy",
      origin: "https://api.example.com",
      access: "routes",
      routes: [{ methods: ["GET"], match: "exact", path: "/old" }],
      credential: { type: "none" },
      allowedHeaders: ["accept"],
      timeoutMs: 1000,
      maxRequestBytes: 1000,
      maxResponseBytes: 1000,
      credentialConfigured: true,
    });
    await f.login();
    const button = () =>
      Array.from(
        f.w.document.querySelectorAll<HTMLButtonElement>(
          "#connection-list button",
        ),
      ).find((x) => x.textContent === "切换为服务级访问")!;
    let disclosure = "";
    f.w.confirm = (message) => {
      disclosure = String(message);
      return false;
    };
    button().click();
    await f.settle();
    assert.match(disclosure, /撤销所有/);
    assert.match(disclosure, /写入和删除/);
    assert.equal(f.calls.filter((x) => x.path === "upgrade").length, 0);
    const edit = Array.from(
      f.w.document.querySelectorAll<HTMLButtonElement>(
        "#connection-list button",
      ),
    ).find((x) => x.textContent === "编辑")!;
    edit.click();
    assert.equal(
      f.w.document.querySelector<HTMLElement>("#legacy-service-note")!.hidden,
      false,
    );
    assert.equal(f.w.document.querySelector('[name="routes"]'), null);
    f.w.document
      .querySelector<HTMLButtonElement>("#connection-dialog [data-close]")!
      .click();
    f.w.confirm = () => true;
    button().click();
    await f.settle();
    assert.equal(f.calls.filter((x) => x.path === "upgrade").length, 1);
    assert.equal(button(), undefined);
    assert.match(
      f.w.document.querySelector("#connection-list")!.textContent!,
      /服务级访问/,
    );
  } finally {
    f.close();
  }
});
