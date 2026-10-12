# 登录、连接 Agent、开始对话

[English](onboarding.md)

用户入口是 **`https://你的服务域名/_agent-router/setup`**。
账号继续由已有的 Matrix 后端管理，执行继续交给 Agent Host。
管理员设置 `AGENT_ROUTER_ONBOARDING_FILE` 后才会启用这个页面。
需要使用当前源码构建；已发布的 v0.6.0 尚未包含它。

## 普通用户怎么用

1. 打开已有服务的入口，登录账号。管理员开放注册时，也可以在这里注册；
   服务可能要求邀请码。已有产品可以通过自己的登录把你带过来。
2. 创建自己的 Agent，例如 `helper`，选择管理员分配给你的执行端。
   模型、运行环境和工作区由管理员提前配置。
3. 按需连接飞书、微信、Telegram、邮件或 Matrix。可以连接多个，也可以
   先不连接，直接在网页、CLI 或 SDK 中使用。
4. 检查连接，再发送一条真实消息，确认 Agent 能收到并回复。

| 平台 | 需要做什么 |
| --- | --- |
| 飞书 / Lark | 扫官方二维码开通应用。如果选择个人服务，再完成一次个人授权，访问日历、文档等；个人工具需要先连接执行端。 |
| 微信 | 扫腾讯 iLink 二维码并确认。手机显示配对码时，在页面输入。仅支持私聊。 |
| Telegram | 在 BotFather 创建机器人，提供 Token，再打开专属链接点击 Start；只有完成该私聊验证的用户会被绑定。 |
| 邮件 | 选择管理员配置的 Grove Mail 服务，提供 Agent 收件箱地址、API Key 和自己的发件地址。此入口不是 Gmail / Outlook OAuth；原有 AgentMail 配置方式仍然保留。 |
| Matrix | 启用后，用已有的 Matrix 账号向 Agent 发消息。 |

配置会私有保存并立即应用，不需要重启 Matrix connector。
账号和渠道 Token、应用密钥、Host Token 留在服务器；网页不会把账号 Token
放进 localStorage。网页对话支持文字任务、真实回复、继续会话、停止任务，
以及刷新后恢复最近任务。网页使用账号下的 `client` Agent 发起 A2A 会话；
它与各渠道按[原有规则](personal-channels.md)共享的私人主会话分别保留。
主人通过网页调用自己的 Agent 时可以使用其个人工具；朋友获准使用 Agent
后，不会因此获得主人的个人工具。
主人页面也会显示 Host 正在等待的问题和权限选择，回答沿用执行内核的原生格式。
密码等敏感输入仍需通过 Host 原生交互入口完成。

### 只用朋友的 Agent

你不需要再启动自己的 Host。

1. 在同一个服务登录，把对话区显示的**调用者地址**发给朋友，例如
   `bob/client@agents.example`。
2. 朋友选择自己的 Agent，在“让朋友使用你的 Agent”里为该地址设置使用权限。
3. 把朋友的 Agent 地址（例如 `alice/helper@agents.example`）填进你的对话区，
   打开后就能发消息。

“允许”直接接收并执行该调用者的请求；“需批准”的请求会显示在主人页面，
由主人逐条允许或拒绝；“拒绝”阻止请求。
这些设置允许使用 Agent，不会转移所有权，也不允许改它的连接、执行端或账号。
网页目前查找同一服务上的 Agent；CLI / SDK 的跨域联邦能力继续保留。

## 管理员需要先做什么

先部署一次[已有的托管节点](managed-agents.md)：Matrix 账号后端、
Application Service 注册、Router 和 HTTPS 入口。再单独启动 Agent Host，
配置真实的运行时、工作区和模型凭据。Host 需要支持 HTTP v1 的健康检查、
运行时检查和任务接口。

构建 Router，生成私有开通配置：

```sh
npm ci
npm run build
npm run onboarding:init -- \
  --out /private/router/onboarding.json \
  --owner '@alice:agents.example' \
  --host-url http://agent-host:8787 \
  --host-token-file /private/router/host-token \
  --runtime personal
```

保留现有 `MATRIX_*`、`AGENT_SERVICE_URL` 等配置，额外设置：

```sh
AGENT_ROUTER_ONBOARDING_FILE=/private/router/onboarding.json npm run agent:service
```

Host 地址必须能从 Router 进程或容器访问。服务之间的 Token 通信应使用 HTTPS
或可信私网。使用根目录 Compose 示例时，把配置和静态 Host Token 放进
`state/agent-service-secrets/`，设置
`AGENT_ROUTER_ONBOARDING_FILE=/secrets/onboarding.json`，
文件中的 Token 路径也需要能在容器内解析。重新构建并重启一次 `agent-service`。
后续渠道凭据和授权刷新数据保存在可写的 `/state/onboarding/` 中，
备份时应与账号注册表、各 Agent 的任务记录一起保存。
Caddy 已经转发 `/_agent-router/*`。

也可以只运行 `onboarding:init --out 文件`，不配置 Host：
用户可以登录并使用已经获准访问的共享 Agent，不必给每个新用户配置执行端。
初始化命令不会覆盖已有配置。

配置结构与各字段的完整示例见[英文说明](onboarding.md#for-service-operators)。
Host 配置必须明确列出可用它的账号；用户只选择配置 ID，不能提交任意服务器地址、
Token 文件路径、可执行命令或工作区。新注册的账号不会自动分到 Host。
`owners` 填的是后端的真实账号 ID；已有产品的身份桥接应使用 SDK 会话返回的
`owner`，而不是产品中的显示名字。

`registration: true`（或初始化命令的 `--registration`）只启用注册入口，
Matrix 后端也必须配置相应注册政策。页面支持密码登录和 dummy / 邀请码注册流程。
其他 Matrix SSO、验证码、条款确认等流程需用兼容客户端，或下面的产品登录入口。

**Router 的账号隔离不等于执行环境隔离。** Host 使用管理员配置的文件系统、
工具和凭据。不同用户的代码不应该互相信任时，需要独立 Host 容器或操作系统边界，
以及私有工作区。给朋友开放执行权限时，应选择你愿意共享其能力的执行环境。

### 对接已有产品账号

继续用[原有身份桥接](product-integration.md)。产品把用户登录交换成 Router
会话后，通过 SDK 获取开通链接：

```ts
const link = await router.onboardingLink();
// 把用户浏览器带到 link.url。
```

页面显示账号身份，用户确认后进入。链接携带一次性、60 秒有效的票据，放在
URL fragment 中，不携带账号 Token；兑换后设置 HttpOnly、SameSite Cookie。
后续请求仍检查原账号会话是否有效，包括身份桥接会话的过期和撤销。
网页不会延长外部会话原有的短期有效期；过期时由产品重新提供登录链接。
管理员可设置 `productLoginUrl` 指回产品登录页，产品仍负责登录、刷新和账号角色。

## 修改、恢复和验证

- 已有 `AGENT_ROUTER_CHANNELS_FILE` 配置会继续读取，直到用户为该 Agent 保存
  开通页配置；保存时会保留它原先的连接。
- 第一次原生执行前可以调整 Host。已经建立原生绑定后，更换 Host、运行时
  或个人工具集合需要新建 Agent，或由管理员明确迁移。执行中、结果未知的任务
  会阻止配置调整。已有个人账号重新授权不改变工具集合。
- 网页登录和等待中的扫码任务在内存里，Router 重启后需重新登录；已保存的连接、
  账号、任务和执行绑定保留。飞书个人授权的等待状态保存在私有目录中，可以恢复。
- 飞书应用创建在出码后中断时，先检查是否已经创建应用。通过[官方开通流程](personal-channels.md)
  将原应用及主人凭据恢复到这个 Agent 的私有飞书目录；只有确认没有创建应用，
  才删除 `creation-pending.json` 后重新扫码。服务不会在结果未知时自动再创建一个应用。
- 连接检查不消费渠道消息、不发送测试消息、不调用模型。真实账号、渠道、模型的
  收发链路仍需通过一条真实消息确认。

开发时，`npm test` 验证登录、注册、账号隔离、短期票据、配置保存和回滚、
主人及朋友的调用权限、Router / Host 模拟服务回复，以及各平台的扫码与配对协议。
构建后可运行 `node scripts/preview-onboarding.mjs` 查看本地模拟页面：
用户名 `alice`、密码 `preview`；模拟服务禁用外部平台开通，不调用真实模型。
