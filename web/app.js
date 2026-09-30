const $ = (selector, root = document) => root.querySelector(selector);
let state,
  csrf = "",
  activeView = "overview",
  toastTimer,
  uiEpoch = 0;
const names = {
  overview: [
    "概览",
    "网关概览",
    "从连接到调用，所有权限与额度一目了然。",
    "CONTROL CENTER",
  ],
  connections: [
    "API 服务",
    "连接你的数据",
    "统一管理上游 Base URL 与 Key，Agent 按原始文档调用。",
    "PROVIDER CONNECTIONS",
  ],
  grants: [
    "Agent 授权",
    "为 Agent 设定边界",
    "每个 Agent 使用独立能力令牌，权限、期限与额度明确可见。",
    "AGENT CAPABILITIES",
  ],
  audit: [
    "审计日志",
    "每次调用都有迹可循",
    "检查预留与结果，查看最近的配置和授权操作。",
    "AUDIT TRAIL",
  ],
};
const messages = {
  admin_unauthorized: "会话已到期，请重新登录。",
  invalid_credentials: "密码不正确。",
  admin_setup_required: "请先通过 SSH 终端设置管理员密码并重启服务。",
  try_later: "登录尝试过于频繁，请稍后再试。",
  invalid_origin: "访问来源不匹配，请使用配置的可信地址。",
  invalid_csrf: "会话验证失败，请刷新页面。",
  grant_exists: "此授权 ID 已存在；请使用新的 ID。",
  invalid_grant: "请检查授权范围、额度与到期时间（最长一年）。",
  invalid_scope: "请先选择已配置的服务。",
  invalid_connection: "请检查服务 Origin、请求头与凭证配置。",
  explicit_migration_required:
    "请使用独立的服务升级操作，普通编辑不会放宽旧限制。",
  migration_not_required: "该服务无需升级，请刷新页面。",
  invalid_quota: "日额度须为 1–1,000,000 的整数。",
  deployment_in_progress: "新版本正在健康检查，请稍后再试。",
  service_unavailable: "操作暂时失败，请稍后重试。",
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = error ? "toast error-toast" : "toast";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 4500);
}
async function api(path, body) {
  let response;
  try {
    response = await fetch("/admin/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers:
        body === undefined
          ? {}
          : { "content-type": "application/json", "x-csrf-token": csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("无法连接网关，请检查网络或 SSH 隧道。");
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "login") showLogin();
    throw new Error(messages[data.error] ?? "操作失败，请检查输入或稍后重试。");
  }
  return data;
}
function showLogin() {
  uiEpoch++;
  $("#console").hidden = true;
  $("#login").hidden = false;
  csrf = "";
  state = undefined;
  $("#password").value = "";
  document.querySelectorAll("dialog[open]").forEach((x) => x.close());
}
function badge(text, kind = text) {
  return el("span", text, "badge " + kind);
}
function empty(root, title, description) {
  root.replaceChildren();
  const node = el("div", undefined, "empty");
  node.append(el("strong", title), el("span", description));
  root.append(node);
}
function table(root, head, rows) {
  root.replaceChildren();
  const wrap = el("div", undefined, "table-wrap"),
    t = el("table"),
    thead = el("thead"),
    tr = el("tr");
  for (const title of head) tr.append(el("th", title));
  thead.append(tr);
  t.append(thead);
  const tbody = el("tbody");
  for (const values of rows) {
    const row = el("tr");
    for (const value of values) {
      const td = el("td");
      td.append(value instanceof Node ? value : el("span", String(value)));
      row.append(td);
    }
    tbody.append(row);
  }
  t.append(tbody);
  wrap.append(t);
  root.append(wrap);
}
function stacked(title, sub) {
  const node = el("div");
  node.append(el("strong", title), el("small", sub));
  return node;
}
const time = (timestamp) =>
  new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
function renderAudit(root, rows) {
  if (!rows.length)
    return empty(
      root,
      "尚无调用记录",
      "Agent 发起已授权调用后，预留与结果会显示在这里。",
    );
  table(
    root,
    ["时间 / 请求", "Agent", "操作 / 连接", "结果"],
    rows.map((x) => [
      stacked(time(x.time), x.request_id),
      x.grant_id,
      stacked(x.method + " " + (x.path ?? "旧版记录"), x.service),
      badge(x.outcome),
    ]),
  );
}
function render() {
  const used = state.globalUsed,
    limit = state.globalDailyUnits,
    active = state.grants.filter((x) => x.status === "active");
  $("#metric-usage").textContent =
    used.toLocaleString() + " / " + limit.toLocaleString();
  $("#metric-date").textContent = state.day + " · UTC";
  $("#usage-meter").style.width = Math.min(100, (used / limit) * 100) + "%";
  $("#metric-connections").textContent = state.connections.length;
  $("#metric-ready").textContent =
    state.connections.filter((x) => x.credentialConfigured).length +
    " 个凭证已配置";
  $("#metric-grants").textContent = active.length;
  const finished = state.audit.filter((x) => x.outcome !== "reserved");
  $("#metric-success").textContent = finished.length
    ? Math.round(
        (finished.filter((x) => x.outcome === "succeeded").length /
          finished.length) *
          100,
      ) + "%"
    : "—";
  $("#global-limit").value = limit;
  $("#migration-note").hidden = !state.migrationRequired.length;
  $("#migration-note").textContent =
    "已保留旧版连接：" +
    state.migrationRequired.join(", ") +
    "。旧授权无法调用通用中转，请重新配置服务并明确授权。";
  renderAudit($("#recent-audit"), state.audit.slice(0, 5));
  renderAudit($("#audit-list"), state.audit);
  const list = $("#connection-list");
  list.replaceChildren();
  if (!state.connections.length)
    empty(
      list,
      "创建你的第一个连接",
      "配置上游 HTTPS Origin 与凭证，再选择允许 Agent 访问的服务。",
    );
  const connectionRows = state.connections.map((connection) => {
    const actions = el("div", undefined, "connection-actions"),
      edit = el("button", "编辑", "secondary"),
      remove = el("button", "删除", "subtle");
    edit.onclick = () => openConnection(connection);
    remove.onclick = async () => {
      if (
        confirm("删除连接 " + connection.id + "？包含此连接的授权将被撤销。")
      ) {
        try {
          await api("connections/delete", { id: connection.id });
          await refresh();
          toast("连接已删除");
        } catch (error) {
          toast(error.message, true);
        }
      }
    };
    actions.append(edit);
    if (connection.access !== "service") {
      const upgrade = el("button", "切换为服务级访问", "secondary");
      upgrade.onclick = async () => {
        if (
          !confirm(
            "将 " +
              connection.id +
              " 切换为服务级访问？这会移除旧路由/方法限制，并撤销所有引用该服务的授权。新授权可调用该服务的全部上游 API，包括写入和删除。",
          )
        )
          return;
        upgrade.disabled = true;
        try {
          await api("connections/upgrade", { id: connection.id });
          await refresh();
          toast("已切换；请重新创建服务级授权。");
        } catch (error) {
          toast(error.message, true);
          upgrade.disabled = false;
        }
      };
      actions.append(upgrade);
    }
    actions.append(remove);
    return [
      stacked(connection.id, connection.origin),
      connection.credential.type,
      badge(
        connection.credentialConfigured ? "已配置" : "待配置",
        connection.credentialConfigured ? "active" : "warning",
      ),
      connection.access === "service" ? "服务级访问" : "旧版限制",
      actions,
    ];
  });
  if (connectionRows.length)
    table(
      list,
      ["服务 / Origin", "注入方式", "凭证", "访问模式", "操作"],
      connectionRows,
    );
  const overview = $("#overview-connections");
  if (!state.connections.length)
    empty(
      overview,
      "尚未连接供应商",
      "配置连接后，为 Agent 创建有限的访问授权。",
    );
  else
    table(
      overview,
      ["服务", "凭证", "访问模式"],
      state.connections.map((x) => [
        x.id,
        badge(
          x.credentialConfigured ? "已配置" : "待配置",
          x.credentialConfigured ? "active" : "warning",
        ),
        x.access === "service" ? "服务级访问" : "旧版限制",
      ]),
    );
  const grantRoot = $("#grant-list");
  if (!state.grants.length)
    empty(
      grantRoot,
      "尚未创建授权",
      "每个 Agent 使用独立的范围与额度。新令牌只在创建时显示一次。",
    );
  else
    table(
      grantRoot,
      ["Agent / 范围", "状态", "日额度 / 总额度", "到期时间", ""],
      state.grants.map((grant) => {
        const scope = el("div");
        scope.append(
          el("strong", grant.id),
          el("small", grant.services.join(", ")),
          el(
            "small",
            grant.restricted
              ? "旧版受限授权 · " + formatRoutes(grant.routes ?? [])
              : "服务级授权 · 按上游文档调用",
          ),
        );
        const action = el(
          "button",
          grant.revoked ? "已撤销" : "撤销",
          "subtle",
        );
        action.disabled = grant.revoked;
        action.onclick = async () => {
          if (confirm("撤销 " + grant.id + " 的后续访问？")) {
            try {
              await api("grants/revoke", { id: grant.id });
              await refresh();
              toast("授权已撤销");
            } catch (error) {
              toast(error.message, true);
            }
          }
        };
        return [
          scope,
          badge(
            {
              active: "有效",
              expired: "已到期",
              revoked: "已撤销",
              migration_required: "需重新授权",
            }[grant.status],
            grant.status,
          ),
          stacked(
            grant.dailyUsed + " / " + grant.dailyUnits,
            grant.used + " / " + grant.totalUnits + " 总额度",
          ),
          time(grant.expiresAt),
          action,
        ];
      }),
    );
  if (!state.adminAudit.length)
    empty(
      $("#admin-audit"),
      "暂无管理操作",
      "创建连接、更新额度和授权操作将在此记录。",
    );
  else
    table(
      $("#admin-audit"),
      ["时间", "操作", "对象"],
      state.adminAudit.map((x) => [time(x.time), x.action, x.subject]),
    );
  $("#updated").textContent =
    "最近同步 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
function switchView(view) {
  activeView = view;
  const [name, title, description, kicker] = names[view];
  $("#crumb").textContent = name;
  $("#page-title").textContent = title;
  $("#page-description").textContent = description;
  $("#page-kicker").textContent = kicker;
  document.querySelectorAll(".view").forEach((x) => (x.hidden = x.id !== view));
  document
    .querySelectorAll("nav button")
    .forEach((x) => x.classList.toggle("active", x.dataset.view === view));
}
async function refresh() {
  const epoch = uiEpoch;
  const next = await api("state");
  if (epoch !== uiEpoch) return;
  state = next;
  csrf = state.csrf;
  $("#login").hidden = true;
  $("#console").hidden = false;
  render();
  switchView(activeView);
}
async function submit(form, action) {
  const button = $('button[type="submit"]', form),
    error = $(".error", form);
  if (button.disabled) return;
  button.disabled = true;
  if (error) error.textContent = "";
  try {
    await action();
  } catch (cause) {
    if (error) error.textContent = cause.message;
    else toast(cause.message, true);
  } finally {
    button.disabled = false;
  }
}
$("#login-form").onsubmit = (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    const password = $("#password").value;
    $("#password").value = "";
    const session = await api("login", { password });
    csrf = session.csrf;
    await refresh();
  });
};
$("#refresh").onclick = () =>
  refresh().catch((error) => toast(error.message, true));
$("#logout").onclick = async () => {
  try {
    await api("logout", {});
    showLogin();
  } catch (error) {
    toast(error.message, true);
  }
};
$("#logout-mobile").onclick = $("#logout").onclick;
document
  .querySelectorAll("[data-view]")
  .forEach((x) => (x.onclick = () => switchView(x.dataset.view)));
document
  .querySelectorAll("[data-close]")
  .forEach((x) => (x.onclick = () => x.closest("dialog").close()));
$("#token-dialog").addEventListener("close", () => {
  $("#new-token").value = "";
});
$("#connection-dialog").addEventListener("close", () => {
  $('[name="apiKey"]', $("#connection-form")).value = "";
});
function openConnection(connection) {
  const form = $("#connection-form");
  form.reset();
  $(".error", form).textContent = "";
  $("#connection-title").textContent = connection
    ? "编辑API 服务"
    : "新建API 服务";
  form.elements.id.readOnly = Boolean(connection);
  $("#legacy-service-note").hidden =
    !connection || connection.access === "service";
  if (connection) {
    form.elements.id.value = connection.id;
    form.elements.origin.value = connection.origin;
    form.elements.credentialType.value = connection.credential.type;
    form.elements.credentialName.value = connection.credential.name ?? "";
    form.elements.credentialPrefix.value = connection.credential.prefix ?? "";
    form.elements.allowedHeaders.value = connection.allowedHeaders.join(", ");
    for (const name of ["timeoutMs", "maxRequestBytes", "maxResponseBytes"])
      form.elements[name].value = connection[name];
  }
  $("#connection-dialog").showModal();
}
$("#add-connection").onclick = () => openConnection();
$("#connection-form").onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submit(form, async () => {
    const values = new FormData(form);
    const type = values.get("credentialType");
    const body = {
      id: values.get("id"),
      origin: values.get("origin"),
      credential:
        type === "none"
          ? { type }
          : {
              type,
              name: values.get("credentialName"),
              prefix: values.get("credentialPrefix"),
            },
      allowedHeaders: String(values.get("allowedHeaders"))
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
      timeoutMs: Number(values.get("timeoutMs")),
      maxRequestBytes: Number(values.get("maxRequestBytes")),
      maxResponseBytes: Number(values.get("maxResponseBytes")),
    };
    const key = values.get("apiKey");
    if (key) body.apiKey = key;
    form.elements.apiKey.value = "";
    await api("connections", body);
    form.closest("dialog").close();
    await refresh();
    toast("连接已保存");
  });
};
function formatRoutes(routes) {
  return routes
    .map((x) => x.methods.join(",") + " " + x.match + " " + x.path)
    .join("\n");
}
function checkbox(root, name, value, label) {
  const node = el("label"),
    input = el("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  node.append(input, el("span", label));
  root.append(node);
}
$("#add-grant").onclick = () => {
  if (!state.connections.length) {
    toast("请先创建 API 服务。");
    switchView("connections");
    return;
  }
  const form = $("#grant-form");
  form.reset();
  $(".error", form).textContent = "";
  $("#grant-accounts").replaceChildren();
  for (const connection of state.connections)
    checkbox($("#grant-accounts"), "services", connection.id, connection.id);
  const expiry = new Date(Date.now() + 7 * 86400000);
  expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset());
  form.elements.expiresAt.value = expiry.toISOString().slice(0, 16);
  $("#grant-dialog").showModal();
};
$("#grant-form").onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submit(form, async () => {
    const values = new FormData(form),
      result = await api("grants", {
        id: values.get("id"),
        schemaVersion: 3,
        services: values.getAll("services"),
        perMinute: Number(values.get("perMinute")),
        expiresAt: new Date(String(values.get("expiresAt"))).getTime(),
        dailyUnits: Number(values.get("dailyUnits")),
        totalUnits: Number(values.get("totalUnits")),
      });
    form.closest("dialog").close();
    $("#new-token").value = result.token;
    $("#token-dialog").showModal();
    await refresh();
    toast("授权已创建，请安全保存令牌。");
  });
};
$("#copy-token").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#new-token").value);
    toast("令牌已复制，请安全保存。");
  } catch {
    toast("复制失败，请选中令牌手动复制。", true);
  }
};
$("#quota-form").onsubmit = (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    await api("quota", { globalDailyUnits: Number($("#global-limit").value) });
    await refresh();
    toast("全局日额度已更新");
  });
};
try {
  const status = await api("status");
  $("#setup-note").hidden = status.configured;
  $("#login-form").hidden = !status.configured;
  if (status.configured) {
    try {
      await refresh();
    } catch {
      showLogin();
    }
  }
} catch (error) {
  $("#login-error").textContent = error.message;
}
