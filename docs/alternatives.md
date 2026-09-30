# 现有方案：借鉴边界，不重造完整平台

本 MVP 目标是个人 Agent 的少量固定付费 API 能力，优先让额度和主密钥边界容易检查。调研只读公开资料与已有项目，没有复制第三方实现。

| 方案                                                         | 有价值的能力                                       | 本项目的取舍                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Nango](https://nango.dev/platform/request-proxy)            | connection → provider credential 注入与受控代理    | 借鉴连接与凭证分离。免费自托管主要是 Auth + Proxy，不代表完整云产品；ELv2 不是 MIT，不能假设随意复制后再许可 |
| [agentgateway](https://github.com/agentgateway/agentgateway) | Apache-2.0；可作为成熟网关/未来入口                | 内置 API-key budget 文档针对 LLM，按响应后记账，不可直接当 TikHub 付费请求的前置硬限额                       |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) | Apache-2.0；MCP 管理、细粒度令牌、审计等控制面参考 | Python 平台对本次 TS 小项目偏重；借鉴细粒度授权与审计理念。本项目独立实现数据库不可用时一律拒绝的策略        |
| [Composio](https://github.com/ComposioHQ/composio)           | 工具与账户连接生态；SDK 为 MIT                     | SDK 开源不意味着完整托管后端可同样自托管，完整企业自托管要单独评估                                           |
| [Pipedream](https://pipedream.com/connect)                   | 托管账户连接/工作流参考                            | 非本次小型完全自控网关的直接替代实现                                                                         |

参考边界：[Nango 免费自托管](https://nango.dev/docs/guides/platform/free-self-hosting)、[Nango 许可证](https://github.com/NangoHQ/nango/blob/master/LICENSE)、[agentgateway API-key 预算说明](https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/apikey-authn/)。

结论：第一步写一个很小的固定操作服务，把“谁能调什么、对哪个账户、最多几次”做实；后续用已有成熟 OAuth/MCP 组件接入，而不是自己编写授权服务器，也不提供无限制通用代理。是否扩大平台应由接入供应商数量、多人协作、远程部署需求决定。
