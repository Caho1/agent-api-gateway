# 扩展 adapter 与产品路线图

目标：供未来不同 Personal Agent 重用的能力层。客户端只调用同一个 REST 合约；供应商适配、凭证注入与授权计量在服务端统一处理。

## 当前已实现

- 通用 `ProviderAdapter` 接口与 `AdapterRegistry`，按账户 provider 路由
- 通用授权/额度/审计核心，不包含 TikHub 路径或字段
- 首个 TikHub adapter；独立第二 mock adapter 验证通用核心可复用
- OpenAPI 3.1 与 Node/Python HTTP 示例；不依赖内部 Agent/Pi 框架
- 本地 CLI 生命周期，SQLite 持久原子调用单位，自动化检查与 CI 配置

## 添加一个供应商

1. 实现 `src/registry.ts` 的 `ProviderAdapter`，明确唯一 id 与固定 operation 名
2. `validateAccount` 严格验证本地 settings；`validate` 严格验证操作参数与账户/资源范围。这两步必须纯本地，无请求、无扣费
3. `invoke` 一次只发一个上游请求，不重试、不自动分页；必须固定主机和路径、禁重定向、设置超时/响应上限、投影输出并脱敏。核心按每次 invoke 预留一个单位，**多请求 adapter 不符合该计量契约**
4. 在 `server.ts` 显式构造 adapter，供应商主密钥从服务端环境/秘密管理器注入；添加到注册表。不要接受客户端指定模块路径或下载插件
5. 在账户配置填写 provider 和 settings；为客户端创建只包含所需账户/工具的 grant
6. 更新 OpenAPI operation/args schemas 与测试，证明错误不会泄露秘密，scope 不可绕过，失败不退款

adapter 是被信任的可执行代码，注册表不是不可信第三方插件沙箱。相同 operation 名可以由不同 provider 实现，账户白名单与 provider 选择仍约束目标；推荐新能力使用供应商或领域前缀，避免语义混淆。

## 接入任意 Personal Agent

当前支持的是标准 HTTP 集成能力，未声称验证了所有框架兼容性。把 `examples/node-client.mjs` 或 Python 示例封装成所在框架的一个工具即可。工具定义只能暴露 operation、账户别名和 args，不暴露 provider key；从安全配置中读取 AGENT_GRANT，不让模型自行修改服务器配置。

示例脚本运行会发一次真实调用，只有配置真实服务且明确授权后才运行。CI 与测试不会运行这些付费示例。

## 后续阶段（尚未实现）

1. 更多只读 adapter：小红书、其他有明确使用授权的数据 API；先提供契约测试与费用边界
2. MCP tool transport：复用同一执行核心，不旁路授权与预算；对外提供符合当前规范的工具描述
3. 成熟 OAuth/OIDC 身份层：短期令牌、audience/resource 校验、标准发现/授权流程；本项目不自己造 OAuth 授权服务器
4. 可部署服务：独立 OS 身份、TLS/反向代理、并发/速率限制、真实幂等性、审计留存与备份恢复
5. 多用户场景：强租户隔离、管理控制台、数据库迁移、供应商定价/余额与账单核对

这些是演进方向，不是已完成的功能或服务承诺；新增付费操作/权限需单独设计与授权。
