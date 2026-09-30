# 管理控制台

使用可信 HTTPS 地址或 SSH 隧道打开 `/admin`。首次管理员密码只能通过服务器可信终端设置，沿用 `npm run admin:password` 或部署中的 `agent-gateway-set-admin`。设置后重启；不要将密码发送给 Agent。

## 服务

管理台的 API 服务表单包含服务别名、HTTPS Origin、凭证注入方式/字段/前缀、请求头白名单、路由与资源上限。路由每行格式为：

```text
GET,HEAD exact /v1/items
GET prefix /v1/catalog
```

`exact` 精确匹配，`prefix` 按路径段边界匹配。空表单路由拒绝全部。不要填完整 URL、通配符、正则或查询字符串。密钥写入私有文件，保存后不回显；留空保留。编辑已有服务会撤销相关授权，再保存失败也不会恢复令牌权限。

## Agent 授权

选择服务，明确填写方法和路由、到期时间、每分钟上限、每日/总次数。有效路由为服务与授权策略的交集。新令牌只显示一次，关闭后需撤销重建。创建授权不是连通性测试，不会联系上游。

CLI 策略示例（过期时间须自行设置为未来 Unix 毫秒）：

```json
{
  "schemaVersion": 2,
  "id": "research-agent",
  "services": ["my-api"],
  "routes": [{ "methods": ["GET"], "match": "exact", "path": "/v1/items" }],
  "expiresAt": 1893456000000,
  "dailyUnits": 100,
  "totalUnits": 1000,
  "perMinute": 10
}
```

```sh
npm run cli -- grant /private/policy.json
npm run cli -- revoke research-agent
npm run cli -- audit 100
```

CLI 是可信管理员工具，允许离线预建 service ID 策略；未知服务运行时仍拒绝。Web 管理台仅允许现有服务。不要将新令牌写进 shell 历史、公开日志或仓库。

## 升级提示

旧连接会作为迁移提示显示。上游凭证、旧授权行、用量、审计、管理员密码保留，但不会自动创建活动服务或扩大旧令牌能力。按新协议重建服务与授权；旧 Agent 请求格式会被拒绝。不要在未获授权时创建临时测试令牌或发送计费请求。

会话到期、重新登录和退出会清理界面中的令牌显示；管理台数据不会写入 localStorage。仅展示最近 100 条审计。服务变更与授权操作会记录管理员审计。

Credential migration note: old provider credentials remain stored for rollback, but generic services never implicitly use legacy ID-based keys. Explicitly enter the key when configuring a v2 service. New keys are bound to the service ID, origin and injection fields, so a partial config write cannot send a new target’s key to the old target. Changing that binding with a blank key leaves the new target unconfigured unless a key was previously saved for that exact binding.
