# 架构与 API

## 数据流

Agent → 本机 POST /v1/invoke → 严格 schema / Host / Origin 校验 → SQLite 授权与额度事务 → 固定 TikHub GET → 响应投影 → 审计结果。

客户端与供应商解耦：`AdapterRegistry` 选择已注册 adapter，核心只负责通用请求 envelope、授权、额度、审计；各 adapter 负责本地设置/参数校验、固定端点与响应投影。adapter 是可信本地代码，不是可由 Agent 上传的远程插件。

可信操作员 → 本地 CLI 或认证后的 /admin → SQLite 授权创建/撤销。管理面板额外使用精确 Origin、短密码会话与 CSRF；CLI 不经由 HTTP。

SQLite 单文件与 WAL 置于受保护目录。多进程使用同一文件时，`BEGIN IMMEDIATE` 串行化授权状态读取、全局/授权日额度、授权总额度与 reserved 审计写入。事务成功后才发上游请求。锁忙、磁盘故障、损坏或未知异常时返回 service_unavailable，不能绕过账本继续请求。不要使用不支持 SQLite 正确锁语义的网络共享盘。

一次调用 = 一个供应商请求 = 一个额度单位。UTC 日期用于日额度。无重试；客户端重试将重新扣额度。预留后崩溃保留 reserved 记录，额度不返还。需要人工核对残留记录，不要自动重新执行。暂无幂等键/缓存/退款机制。

## POST /v1/invoke

Headers: Authorization: Bearer <agent-grant>；Content-Type 为 application/json，可附带 charset=utf-8。请求 ≤8 KiB。仅接受三个顶层字段：operation、account、args。

| operation     | args                          | 说明                            |
| ------------- | ----------------------------- | ------------------------------- |
| posts.list    | {} 或 {"cursor":"数字字符串"} | 固定每页 count=20；不自动翻页   |
| posts.metrics | {"postId":"数字字符串"}       | 仅本地配置账户的 postIds 白名单 |

成功：{"requestId":"UUID","data":...}。错误：{"requestId":"UUID","error":"固定代码"}。

401 unauthorized；403 forbidden；400 invalid_request/invalid_arguments/invalid_json；413 request_too_large；415 json_required；429 quota_exceeded；502 upstream_unavailable；503 service_unavailable。未知路径或方法 404。GET /healthz 提供最小本地进程健康响应；独立的 /admin 管理端点见 admin.md。

## TikHub 适配

主机固定 https://api.tikhub.io，不接受客户端传入 host/path/header。

- posts.list → GET /api/v1/douyin/app/v3/fetch_user_post_videos，参数 sec_user_id、max_cursor、count=20、sort_type=0、channel=normal
- posts.metrics → GET /api/v1/douyin/app/v3/fetch_video_statistics，参数 aweme_ids（一个预先批准的 ID）

供应商 HTTP 2xx 且 body.code 可转为数字 200 才视作成功。列表每项 author.sec_uid 必须与配置一致，否则整次失败；缺字段也失败。输出仅 id/title/createdAt 与分页字段，不透传原始数据。播放量要求安全非负整数，否则 null。不会使用列表常见占位 play_count=0 来替代真实播放量。

接口映射根据已有授权集成经验整理；独立实现供应商接口的固定路径与字段契约，不包含任何账户 ID、私有业务数据或第三方源码。上线前仍需进行授权契约验证。

## 后续演进

1. 在隔离服务运行用户下保管主密钥与数据库，Agent 只获得网络能力凭证
2. 如接入远程 MCP，使用成熟 OAuth 2.1/OIDC 授权服务，遵循当前 MCP authorization 规范；校验 audience/resource/scope、短生命周期与撤销，不能把这个本地 Bearer 方案称为 OAuth
3. 把已有操作封装成 MCP tools；保持同一授权和额度内核，不另开绕过路径
4. 按官方/真实授权响应建立契约测试，再增加小红书独立只读 adapter；保留缺失指标，不制造数据
5. 上线前增加并发限制、速率限制、持久审计归档、备份/恢复、供应商端额度与告警，必要时换 PostgreSQL 事务账本

提供明确的 systemd/Caddy 部署配置；不自动注册 OAuth 应用、创建平台凭证或执行真实付费调用。
