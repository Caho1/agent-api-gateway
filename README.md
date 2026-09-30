# Agent API Gateway

A self-hosted, authenticated API relay for agents. The administrator fixes each service's HTTPS origin and credential injection. An agent supplies a service alias, HTTP method, relative path, query and body according to the **original upstream API documentation**. There are no provider business adapters, post-ID settings or response normalizers.

## 安全边界

- Agent 只持有独立、可撤销、到期的网关令牌；上游密钥留在服务器
- 服务与授权分别定义 HTTP 方法和路由，两者取交集；空路由默认拒绝
- SQLite 事务原子预扣总次数、UTC 日次数及固定窗口每分钟次数；全局日次数另有限制
- 解析所有 DNS 地址，任一非公网地址即拒绝；经检查的地址绑定实际 TLS 连接，不重新解析、不复用连接、不走环境代理
- 仅 HTTPS、相对路径；拒绝重定向、路径混淆、危险请求头和凭证字段冲突
- 请求体、目标 URL、响应头、响应体与整个上游请求均有上限
- 原始 JSON 结构保留，并附原始字节的 base64；非 JSON 返回 base64
- 管理员密码、30 分钟会话、精确 Origin、CSRF 和 CSP 保护继续保留

这不是货币预算、上游数据所有权验证器或恶意上游内容过滤器。只配置可信上游；在服务商侧设置配额和最小权限密钥。完整边界见 [安全说明](docs/security.md)。

## 本地启动

Node.js 24+。无需 Docker。

```sh
npm ci --ignore-scripts
cp config.example.json config.json
npm run admin:password
npm run check
npm run build
node dist/server.js
```

打开 `http://127.0.0.1:8787/admin`。密码由可信终端设置，浏览器没有公开初始化入口。不要将 Agent 与网关部署为同一个系统身份。

默认示例配置没有服务或授权，不会发送任何上游请求。通过管理台添加服务，并明确填写允许的路由；保存密钥后只显示是否已配置。编辑已有服务会撤销引用它的授权，以免旧令牌继承新的目标或凭证。

## 调用协议

```json
{
  "service": "my-api",
  "method": "GET",
  "path": "/v1/items",
  "query": { "page": "1", "tag": ["a", "b"] },
  "headers": { "accept": "application/json" }
}
```

向 `POST /v1/relay` 发送 JSON，并使用 `Authorization: Bearer <gateway-token>`。`/v1/invoke` 是相同通用协议的兼容入口，不接受旧版 `operation/account/args` 格式。Agent 不传上游凭证或完整 URL。

- `body`：任何 JSON 值，按 JSON 序列化；默认注入 `content-type: application/json`
- `bodyBase64`：非 JSON 的原始请求体；与 `body` 互斥，请求头需在服务允许列表中
- `GET` / `HEAD` 不接受请求体；`query` 的值只接受字符串或字符串数组
- 一次调用只发一个上游请求，不自动重试、翻页或跟随重定向

成功中转（包括上游 4xx/5xx）返回网关 HTTP 200：

```json
{
  "requestId": "...",
  "data": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "encoding": "json",
    "body": { "the": "original upstream shape" },
    "rawBodyBase64": "..."
  }
}
```

请先检查网关 HTTP 状态，再检查 `data.status`。`data.body` 不做供应商字段重写；JavaScript 数值精度限制仍适用，需要大整数精确性时解码 `rawBodyBase64` 并使用适当解析器。二进制、无效 JSON 或空响应使用 `encoding: "base64"`，`body` 为原始字节的 base64 字符串。

## 服务与授权

服务示例（只保存公开配置，凭证通过管理台单独写入）：

```json
{
  "origin": "https://api.example.com",
  "credential": {
    "type": "header",
    "name": "Authorization",
    "prefix": "Bearer "
  },
  "routes": [{ "methods": ["GET"], "match": "prefix", "path": "/v1/items" }],
  "allowedHeaders": ["accept", "content-type"],
  "timeoutMs": 10000,
  "maxRequestBytes": 262144,
  "maxResponseBytes": 1048576
}
```

`credential.type` 可为 `header`、`query`、`none`。凭证字段与调用者字段冲突会拒绝，不会覆盖后放行。`prefix` 只用于公开前缀，例如 `Bearer `，不要在配置中放密钥。

路由 `exact /v1/items` 只允许该路径；`prefix /v1/items` 允许本身及 `/v1/items/...`，不会匹配 `/v1/items-admin`。不使用正则、通配符或完整 URL。所有查询参数和请求体受上游语义约束，网关不会判断其业务含义；不要对不可信 Agent 开放可转发 URL、任意 SQL 或脚本执行类上游接口。

授权示例见 [管理说明](docs/admin.md)。CLI 保留 `grant POLICY.json`、`revoke ID` 和 `audit LIMIT`，创建令牌是明确的管理员操作。

## TikHub 只是第一个示例

服务 Origin 为 `https://api.tikhub.io`，凭证注入为 `Authorization: Bearer `。为需要的原始 API 路径分别授权即可，无需代码适配器。

[Node 示例](examples/node-client.mjs) 和 [Python 示例](examples/python-client.py) 演示直接使用 [TikHub 用户作品 API 文档](https://docs.tikhub.io/186826223e0) 中的方法、路径和参数。示例需管理员先配置相同服务和精确路由，运行可能产生上游费用；本仓库测试全部使用模拟上游。

## 升级、PM2 与发布

[部署手册](docs/deployment.md) 包含 PM2 under systemd、首次升级、`publish.sh`、健康检查和失败回滚。应用使用 PM2；Caddy 保持原生 systemd 与自动续证，不由 PM2 接管。

旧版配置在内存中转换为无活动服务的 v2，并保留 `legacyAccounts`；旧版授权、用量、审计、凭证和管理员密码不删除。旧授权不会自动变成通用路由授权。必须由管理员重新配置、明确授权。首次保存会写入 v2 配置；保存后回退 PR2 必须处理语义不兼容，不可盲目恢复旧数据库而重置用量。

发布脚本只取 `origin/main`，不合并 PR、不自动部署新分支。当前运行版本以 `/healthz` 和部署记录为准，仓库文档不代表已经发布。

## 开发与验证

```sh
npm run check
```

包含 Prettier、ESLint、源码/测试类型检查、Node 测试和 TypeScript 构建。测试覆盖管理安全、迁移、策略边界、持久配额/速率、并发、DNS/连接固定、响应泄漏与发布回滚。见 [OpenAPI](openapi.json)、[架构](docs/architecture.md) 和 [扩展服务](docs/extending.md)。

MIT license; original LICENSE retained.

Credential migration note: old provider credentials remain stored for rollback, but generic services never implicitly use legacy ID-based keys. Explicitly enter the key when configuring a v2 service. New keys are bound to the service ID, origin and injection fields, so a partial config write cannot send a new target’s key to the old target. Changing that binding with a blank key leaves the new target unconfigured unless a key was previously saved for that exact binding.
