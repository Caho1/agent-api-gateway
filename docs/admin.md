# 管理控制台

使用可信 HTTPS 地址或 SSH 隧道打开 `/admin`。首次管理员密码只能通过服务器可信终端设置，沿用 `npm run admin:password` 或部署中的 `agent-gateway-set-admin`。设置后重启；不要将密码发送给 Agent。

## 服务

管理台只需配置服务别名、上游 HTTPS Origin（Base URL）与凭证注入。无需填写允许的路由或方法。请求头和传输上限收在“高级”中，有安全默认值。密钥写入私有文件，保存后不回显；留空保留。编辑已有服务会撤销相关授权，保存失败也不会恢复令牌权限。

若服务标为“旧版限制”，普通编辑与 Key 轮换会保留原限制。要改为全服务访问，使用列表中独立的“切换为服务级访问”按钮：确认框会说明它移除旧方法/路由限制并撤销所有关联授权，新授权可使用上游 Key 的全部 API，包括写入与删除。取消确认不做任何改动。转换成功后再明确创建新的服务级授权。

## Agent 授权

选择服务，填写到期时间、每分钟上限、每日/总次数即可。新授权按服务鉴权，路径与参数直接遵循上游文档；不再提供路由/方法表单。请确认上游 Key 的业务权限适合此 Agent，服务级访问包含其可执行的写入与删除。新令牌只显示一次，关闭后需撤销重建。创建授权不是连通性测试，不会联系上游。

CLI 策略示例（过期时间须自行设置为未来 Unix 毫秒）：

```json
{
  "schemaVersion": 3,
  "id": "research-agent",
  "services": ["my-api"],
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

旧路由授权继续保留原限制，显示为“旧版受限授权”；新的 v3 授权无法绕过尚未转换的旧服务限制。没有权限标记的旧配置保持原来的默认拒绝行为。上游凭证、授权行、用量、审计和管理员密码都保留。历史业务适配器账户仍需重建，旧 `operation/account/args` 请求格式继续拒绝。不要在未获授权时创建临时测试令牌或发送计费请求。

会话到期、重新登录和退出会清理界面中的令牌显示；管理台数据不会写入 localStorage。仅展示最近 100 条审计。服务变更与授权操作会记录管理员审计。

Credential migration note: old provider credentials remain stored for rollback, but generic services never implicitly use legacy ID-based keys. Explicitly enter the key when configuring a v2 service. New keys are bound to the service ID, origin and injection fields, so a partial config write cannot send a new target’s key to the old target. Changing that binding with a blank key leaves the new target unconfigured unless a key was previously saved for that exact binding.
