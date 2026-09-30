# 管理控制台与部署

管理地址为 `/admin`。供应商主密钥只写入服务端受保护文件；API 状态、审计、错误和后续编辑不返回密钥。授权令牌在创建时显示一次，SQLite 只保留摘要。删除连接先撤销包含该连接的授权，重新使用连接别名不会恢复旧授权。

## 本地安全启动

需要 Node 24 或更新版本。没有管理员密码文件时，界面可查看设置提示，全部管理数据与变更接口保持锁定；没有公开的首次认领接口。

```sh
npm ci --ignore-scripts
cp config.example.json config.json
npm run admin:password
npm run dev
```

密码通过交互终端隐藏输入，至少 16 字符；仅保存带随机 salt 的 scrypt 摘要。已存在的密码文件不会被覆盖。默认打开 `http://127.0.0.1:8787/admin`，账户为 `admin`。主密钥可在登录后的连接表单中输入，或延续使用原有 `TIKHUB_API_KEY` 环境配置。表单保存的是每个连接独立的凭证。

设置 `ADMIN_ORIGIN` 为精确访问 origin（协议、主机、端口）；公开地址必须是可信 HTTPS。默认会话 30 分钟，不持久化，服务重启使其全部失效。登录轮换当前会话；退出登录使对应会话立即失效。所有管理变更需要 exact Origin、HttpOnly / SameSite=Strict cookie 和随机 CSRF token，HTTPS 使用 Secure cookie。登录具有全局短期节流。密码变化需操作员通过可信 SSH 管理受保护的摘要文件并重启，不提供网络修改接口。

## 129.204.35.13 部署

`deploy/` 给出此部署的明确配置：Node 24.21.0，Caddy 2.11.4；应用绑定 `127.0.0.1:8787`，两个 systemd 服务使用独立 DynamicUser，状态目录 mode 0700、文件 mode 0600。代码位于 `/opt/agent-api-gateway/releases/<commit>`，`current` 指向当前版本。环境文件仅保存路径和 origin。没有 API/provider 密钥或管理员密码随源码部署。

Caddy 明确使用 Let's Encrypt ACME issuer 与 `shortlived` profile，为 IP 签发浏览器可信证书；IP 证书有效期约 160 小时，自动续期。签发账户和证书私钥由 Caddy 保管在独立持久状态目录 `/var/lib/gateway-caddy`。Caddy 管理 API 关闭，无请求正文/Authorization 访问日志。80 用于验证与跳转，443 仅代理 `/admin`、`/admin/*`；其它路径 404。已有防火墙与系统安全策略不修改。

首次设置通过可信 SSH 执行：

```sh
ssh -t -i /path/to/your/key.pem root@129.204.35.13 /usr/local/sbin/agent-gateway-set-admin
```

操作员在终端亲自输入并确认密码；脚本不会回显密码，保存摘要后调整状态文件归属并重启应用。随后访问 `https://129.204.35.13/admin`，使用账户 `admin` 和刚设置的密码。不要绕过 SSH host-key 或浏览器证书警告。

**Agent 调用接口目前保持本地访问。** 公共反向代理不开放 `/v1/invoke`。远程 Agent 需要由操作员建立受保护的 SSH 隧道：

```sh
ssh -N -L 8787:127.0.0.1:8787 -i /path/to/your/key.pem root@129.204.35.13
```

Agent 用自己的能力令牌向 `http://127.0.0.1:8787/v1/invoke` 发起请求。管理面板仍使用配置的 HTTPS origin。若 HTTPS 尚未完成，可在本地 SSH 运维中将 ADMIN_ORIGIN 配置为 `http://127.0.0.1:8787` 后重启，通过同一隧道访问；这不是公开 HTTP 密钥入口。

## 管理 API

全部路径位于 `/admin/api/`，响应 no-store。公开只提供 status（仅 configured）与 login；state 需要管理员会话。POST connections 保存固定 TikHub 设置与可选写入密钥，connections/delete 删除连接并撤销相关授权，grants 创建账户/操作/期限/额度授权（重复 ID 409），grants/revoke 幂等撤销，quota 设置全局日额度，logout 注销当前会话。管理表单不能安装 adapter、自定义 upstream URL 或测试付费调用。

管理状态提供 UTC 当日全局/授权额度、总额度、有效/过期/撤销状态、最近 100 条请求最小审计字段与管理操作记录。调用预扣后不退款，reserved 是未完成的请求。日志没有主密钥、token hash、能力令牌、参数或原始响应。

## 运行与边界

可信管理员、服务 OS 身份、配置/数据库/密钥目录处于信任边界内。凭证文件受 OS 权限保护，未声称提供主机被攻破后的密钥加密隔离。Agent 不能读取这些目录或运行管理 CLI；同一 OS 用户的任意代码可绕过网关。管理者改变连接账户或作品范围会改变相关授权的有效资源；删除连接自动撤销，编辑连接由可信管理员负责核对。

没有 OAuth/OIDC、多管理员、分布式存储、货币预算保证或自动审计保留/备份。会话与节流保存在进程内；审计长期增长，应由操作员安排保留与受保护备份。两个配置文件分别原子替换，不能声称跨文件事务。部署验证不发起 TikHub 付费调用，供应商契约仍需用户授权验证。

运维检查：
`systemctl status agent-api-gateway gateway-caddy`；
`curl http://127.0.0.1:8787/healthz`；
客户端正常证书验证下访问 HTTPS。回滚可切换 current 到已验证旧 release 并重启应用，不删除状态目录。
