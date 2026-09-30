# agent-api-gateway

给各种 Personal Agent 使用的**受限能力网关**：一套授权与额度内核，多个可插拔供应商 adapter；Agent 只拿能力凭证，主 API 密钥保留在服务端。

不依赖某个 Agent 框架，也不是 GitHub API 代理。任何能调用 HTTP 的客户端都可按相同 REST/OpenAPI 合约接入；当前首个 adapter 是 TikHub 抖音只读 API。

这是一个可运行、默认仅监听本机的 TypeScript / Node.js MVP。当前接入抖音只读查询：按配置账户列作品、按预先批准的作品 ID 读播放量。没有写入社交平台的能力、任意 URL 代理或公网管理接口。暂不包含小红书、MCP 传输、OAuth 服务、生产部署。

## 核心边界

- TikHub 主密钥只在服务端环境变量中；Agent 使用独立、随机、可撤销的 Bearer 凭证
- 凭证限定账户、工具、失效时间、每日及总调用次数；数据库只存 SHA-256 凭证摘要
- 每次上游请求之前，在 SQLite `BEGIN IMMEDIATE` 事务中预扣 1 调用单位；进程并发、重启仍有效
- 全局每日调用上限；失败、超时、崩溃不退还额度；无自动重试、无隐式分页
- 当前 TikHub adapter：固定 HTTPS 主机、固定只读 GET 路径、严格参数、禁跟随重定向、10 秒超时、1 MiB 响应上限
- 输出字段白名单；错误只返回固定代码；审计不保存密钥、请求正文、原始响应或内容标题

**调用单位不等于美元或人民币。** 实际 TikHub 价格可能按端点变化，余额和账单仍应在供应商侧限制与核对。本项目不保证货币金额硬上限。

## 运行

需要 Node.js 24+（使用内置 `node:sqlite`，其 API 仍可能带实验性提示）与 npm。

```sh
npm ci
npm run check
cp config.example.json config.json
```

编辑 `config.json`，每个账户用 `provider` 选择服务端已注册 adapter，`settings` 放该 adapter 的账户配置。将 `settings.secUid` 替换为自己有权访问的抖音账户，`postIds` 替换为该账户自己作品的数字 ID。示例中的占位符会导致配置校验失败，避免误用。账户名是本地别名，Agent 无法传入任意 sec_uid。作品所有权由操作员离线核实；不要批准他人或不确定归属的 ID。

服务端环境变量（不要提交 `.env` 或密钥）：

```sh
export TIKHUB_API_KEY='YOUR_PROVIDER_KEY'
export GATEWAY_CONFIG='./config.json'
export GATEWAY_DB='./state/gateway.sqlite'
npm run dev
# 或 npm run build && node dist/server.js
```

程序不自动加载 `.env`；如需使用文件，可运行 `node --env-file=.env src/server.ts`。主密钥不能发送给 Agent。只监听 `127.0.0.1:8787`，不提供可配置公网监听地址。默认拒绝浏览器 Origin 与非本机 Host。

## 创建一个受限授权

以下只是格式示例，不是已创建的凭证。创建 `policy.json`，调整有效期（Unix 毫秒，必须晚于当前时间）：

```json
{
  "id": "research-agent",
  "accounts": ["my-douyin"],
  "operations": ["posts.list", "posts.metrics"],
  "expiresAt": 1893456000000,
  "dailyUnits": 10,
  "totalUnits": 30
}
```

```sh
npm run cli -- grant policy.json
```

该命令由本机可信操作员执行，输出一次新生成的 256 位随机凭证。请用安全方式转交给被授权客户端，避免写入日志、截图、共享文件或 shell 历史。没有 Web 管理端。CLI 与服务端必须指向同一数据库。不要给 Agent 访问主密钥环境、SQLite 文件、配置文件或管理 CLI 的能力；同一 OS 用户下的任意 shell 执行不是隔离边界。

客户端示例（`AGENT_GRANT` 仅为自己的能力凭证）：

```sh
curl http://127.0.0.1:8787/v1/invoke \
  -H "Authorization: Bearer $AGENT_GRANT" \
  -H 'Content-Type: application/json' \
  -d '{"operation":"posts.list","account":"my-douyin","args":{}}'

curl http://127.0.0.1:8787/v1/invoke \
  -H "Authorization: Bearer $AGENT_GRANT" \
  -H 'Content-Type: application/json' \
  -d '{"operation":"posts.metrics","account":"my-douyin","args":{"postId":"YOUR_APPROVED_NUMERIC_POST_ID"}}'
```

`posts.list` 每次只取一页，返回 `nextCursor`；下一页要再次调用并消耗额度。不会因列表返回了某作品就自动加入 metrics 白名单。`posts.metrics` 只返回专门统计端点的 `plays`，缺失/无效值返回 `null`，不伪造为 0。列表 ID 保留原始大整数精度。输出是未经信任的社交内容，客户端不能把标题当系统指令。

撤销与审计：

```sh
npm run cli -- revoke research-agent
npm run cli -- audit 50
```

撤销阻止后续额度预留，已提交并正在进行的请求不会被回滚。更新授权应先撤销，再用新 ID 重新创建；本 MVP 不支持原地编辑授权。

## 验证与文档

```sh
npm run lint
npm run typecheck
npm test
npm run build
# 一次运行全部检查
npm run check
```

测试只使用假凭证与 mock 上游；并发测试启动 10 个本地子进程。没有调用真实 TikHub，也没有验证当前账户真实响应。接口映射参考既有实现，生产使用前需要操作员授权后进行低额度契约验证。

- [OpenAPI 3.1 合约](openapi.json)
- [Node 客户端](examples/node-client.mjs) / [Python 客户端](examples/python-client.py)
- [扩展 adapter 与路线图](docs/extending.md)
- [架构与接口](docs/architecture.md)
- [威胁模型与限制](docs/security.md)
- [现有方案比较](docs/alternatives.md)

本项目是个人原型，不宣称已实现 OAuth、安全多租户隔离或生产级认证。远程 Agent 接入前，需要独立受保护的运行身份、TLS、成熟身份层、网络限制、运维与审计留存设计。

## English overview

A small, client-neutral capability gateway for personal agents. Keep provider credentials server-side; issue independently revocable, account/tool-scoped grants with expiry and atomic persistent call-unit quotas. A trusted adapter registry separates provider details from the shared policy/execution core. The first adapter supports read-only TikHub Douyin operations.

Node 24+, zero runtime dependencies, SQLite transactions, REST + OpenAPI, Node/Python examples. Local-only MVP: no OAuth server, no MCP transport, no claim of production-grade isolation. See the security model before running real credentials. Future integration targets existing OAuth/MCP components rather than a custom authorization server. MIT license.
