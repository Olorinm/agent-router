# 多渠道个人对话

当前源码实现五渠道文字对话，以及飞书扫码配置、个人授权和官方 CLI 工具调用；尚未发布到 v0.6.0。Router 负责统一收发、连接凭据和会话映射，Agent Host 负责原生 Agent 执行。

```text
飞书 / Telegram / 微信 / 邮件 / Matrix
                  ↕
       渠道适配器 → Inbox / 会话映射 / Outbox
                  ↕
           现有持久化工作队列
                  ↕
         执行桥 → 固定 Agent Host runtime
```

同一所有者明确绑定的私聊地址共享主会话。每轮回复使用该轮保存的原渠道、原聊天、原消息；群聊和其他联系人使用独立会话。

## 最小启动

1. 按[托管 Agent 指南](managed-agents.md)运行节点并创建一个 Agent，取得其 `agentId`。
2. 按 [Agent Host 服务指南](../../../agent-host/docs/http-service.md)启动一个 runtime。原生 Agent 的认证由 Host 管理；Router 只持有 Host 服务 token。
3. 使用当前源码构建 Router：`npm ci && npm run build`。Node.js 24+。
4. 创建私有 `channels.json`，先接 Matrix 与 Host：

```json
{
  "agents": [{
    "agentId": "替换为已有 Agent 的 UUID",
    "host": {
      "url": "http://127.0.0.1:37420",
      "tokenFile": "host-token",
      "runtimeId": "personal"
    },
    "connections": [{ "id": "matrix", "kind": "matrix" }]
  }]
}
```

`host-token` 文件保存 Host token；所有凭据路径相对 `channels.json` 所在目录。保留原服务的 `MATRIX_*`、`AGENT_SERVICE_URL` 等配置，额外设置：

```sh
AGENT_ROUTER_CHANNELS_FILE=/absolute/path/channels.json npm run agent:service
```

Matrix 默认绑定这个 Agent 的所有者。给 Agent 发普通文字即可进入 Host；未配置的 Agent 保持原有 Matrix/A2A 行为。`host` 可省略，此时消息进入已有队列，由现有 worker 领取。配置了直连 Host 后，这个 Agent 的普通对话由固定实例执行，默认实例名为 `channel-host`；不要让另一个 worker 竞争领取这份队列或使用同名实例凭据。已有 AgentMail 的逐任务 `execution.accessMode` 仍交给支持该约束的外部 worker，直连 Host 不领取这类任务。需要同时使用 AgentMail 和直连个人聊天时，请使用不同的 Agent，避免 worker 竞争。

Compose 部署把 `channels.json`、Host token、Telegram token 等静态配置放在已有 `state/agent-service-secrets/` 只读挂载目录，设置 `AGENT_ROUTER_CHANNELS_FILE=/secrets/channels.json`，重新构建并启动 `agent-service`。飞书授权目录需要写入与刷新，放到 `/state` 可写挂载，不能放在 `/secrets`。`host.url` 必须是 Router 容器能访问的地址；容器里的 `127.0.0.1` 指容器自身。

五渠道示例见 [channels.example.json](../../examples/personal-agent/channels.example.json)。删除不用的连接；示例里的地址和 UUID 都需要替换，不能直接用于真实账号。

## 各渠道怎么连接

| 渠道 | 复用实现 | 必填连接配置 | 第一版边界 |
| --- | --- | --- | --- |
| 飞书 | [官方 Channel](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)，SDK 1.74.0；[官方 CLI](https://github.com/larksuite/cli/blob/main/README.zh.md) 1.0.97 | `credentialsFile`；个人资源开启 `personalTools` | 长连接收信、文字回复；个人授权后调用官方工具；群聊需要 @机器人 |
| Telegram | [grammY](https://grammy.dev/)，1.46.0 | `botTokenFile` | 长轮询，私聊和群组 topic；一个 bot 只有一个收信进程 |
| 微信 | [腾讯插件](https://github.com/Tencent/openclaw-weixin) 2.4.9 的协议与扫码登录代码 | `credentialsFile` | iLink 私聊，沿用每条消息的 `context_token`；不支持群回复 |
| 邮件 | 现有 Grove Mail 服务 | `url`、`inboxId`、`apiKeyFile` | 持久化事件 API 收信，原消息 reply API 回复；不自动 reply-all |
| Matrix | 现有 Application Service / Connector | 无额外 token | 原来的同步进程，普通聊天和原生线程；不支持加密房间 |

### 飞书：扫码配置与个人授权

在实际运行 Router 的机器上执行：

```sh
npm run feishu:setup -- /absolute/private/path/feishu
```

第一次使用有两个确认步骤：官方 `registerApp` 二维码创建 PersonalAgent 应用，取得机器人身份；官方 CLI Device Flow 二维码授予该应用访问个人资源。应用配置沿用平台默认模板，并增加收发消息和 `im.message.receive_v1` 事件。第二步默认 `--domains all`，授权页展示实际申请的个人权限；可以使用 `--domains calendar,docs,drive` 缩小业务范围。Lark 使用 `--domain lark`。

非交互终端或 `--no-wait` 会输出个人授权链接和 PNG 路径后退出。用户确认后续接同一流程：

```sh
npm run feishu:setup -- /absolute/private/path/feishu --complete
```

成功时输出 `status: ready` 和可复制的连接配置：

```json
{
  "id": "feishu",
  "kind": "feishu",
  "credentialsFile": "/absolute/private/path/feishu/credentials.json",
  "personalTools": true
}
```

将它放进已有 Agent 的 `connections` 数组。`ownerOpenId` 从扫码结果绑定，默认不用手抄用户 ID。个人工具还需要前面的 `host` 配置。目录保留应用凭据、待完成授权、CLI 配置和工作文件，私有文件以 0600 写入。Linux 授权密文和密钥位于该目录的 `cli-data/lark-cli/`；macOS 使用官方 CLI 的系统 Keychain。不要把 macOS 配置复制到 Linux 后当作已完成授权，应在服务实际运行环境重新授权。

Compose 已启动节点时，可在可写状态挂载里配置：

```sh
docker compose exec agent-service node dist/services/feishu/setup.js /state/connections/feishu
```

容器里的连接配置引用 `/state/connections/feishu/credentials.json`；相应宿主目录需由容器用户拥有写权限。更新镜像后再运行此命令。保留整份目录，尤其 Linux 的 `cli-data`，才能在重启后刷新授权。

Agent Host 获得一个按连接命名的飞书工具，通过 Router 调用项目内固定版本的官方 CLI。日历、文档、云盘、通讯录等使用官方 `skills`、`schema` 和命令实现。CLI 自动刷新 token；授权缺失、失效或缺少用户 scope 时，工具返回原样授权链接，Router 自动续接用户确认。应用或管理员层面的权限缺失保留官方控制台指引，不通过重复个人授权解决。平台实际开放的能力仍以该应用和租户为准。

个人工具仅给明确绑定的所有者私聊任务；从其他已绑定渠道发来的本人私聊也能使用。群聊、其他联系人和 A2A 请求不获得它。本地已登录的全局 `lark-cli` 配置不会自动迁移到 Router；它们是独立连接。

已有手动创建的机器人仍可以用 `appId`、`appSecretFile`、`domain`、`ownerAddresses` 配置纯聊天；它与 `credentialsFile` 互斥。手动应用需要启用机器人、长连接事件订阅、实际聊天范围所需的收信和发信权限。Router 使用官方 Channel 的规范化消息与发送接口，自己的队列负责执行串行。

### Telegram、微信、邮件和 Matrix

Telegram 用 [BotFather](https://core.telegram.org/bots/features#botfather) 创建 bot，token 写入私有文件。启动时检查 `getWebhookInfo`，既有 webhook 会报错并停止，不自动删除；不能同时运行另一个 polling bot。群消息受 bot 隐私模式和群权限约束，`ownerAddresses` 使用真实用户数字 ID，不使用 username。这是 Bot API 连接，不是个人 Telegram 账号登录。

微信先执行：

```sh
npm run weixin:login -- /absolute/path/weixin.json
```

终端显示二维码和链接；需要配对码、刷新二维码时沿用腾讯登录流程。登录成功后凭据以 0600 写入文件，不打印 token。配置引用该文件即可；默认把此次扫码返回的 `userId` 绑定为所有者。更换微信账号使用新的连接 ID；同一账号登录过期后重新扫码、更新凭据并重启服务。腾讯协议保存在 `src/channels/weixin/vendor/`，附许可证、版本与原文件哈希；更新脚本不会安装 OpenClaw。

微信是腾讯 iLink bot 配对，不是登录并读取个人微信的全部历史、联系人或群聊。当前收发沿用腾讯协议支持的私聊。

邮件已有 Grove Mail inbox 和 API key 直接使用。只消费新到达的 `message.received` 快照，跳过发送事件和已有历史；游标按邮箱保存。服务返回 `410` 时停止收信并报告，不清空游标。需要重新确定起点时，先从 Grove Mail 确认有效游标，再配置新的连接 ID 和 `initialCursor`；已有连接的持久化游标优先于该初始值。当前没有个人 Gmail / Outlook OAuth 和 IMAP 接入。

Matrix 复用托管节点的 Application Service 身份和原同步进程；所有者仍用原 Matrix 登录，不额外创建一份个人授权。当前服务启动沿用托管 Matrix 节点，即使只配置其他渠道也需保留它的基础配置。

## 地址、群聊和状态

`ownerAddresses` 明确关联同一个人的各平台身份；其他联系人放在 `peerAddresses`。这些值来自真实平台事件，不根据消息正文里的自称绑定。Matrix 默认使用 Agent 所有者，微信和飞书凭据目录默认使用扫码身份，其他渠道需要填写。

暂不知道飞书或 Telegram 用户 ID 时，先保持 `ownerAddresses: []`，给机器人发私聊，再读取状态的 `inbox[].sender`，核对身份后写入配置并重启。未绑定身份的消息会保存为 `ignored`，不会启动模型，也不会在后来修改绑定时自动重跑。

群聊同时填写 `groupIds` 和允许的发送人地址。群聊/话题不会共享私人主会话。邮件有多个 To/CC 收件人时按群聊线程处理，只有显式配置相应线程才执行；回复仍只走原邮件 reply。

状态接口沿用托管服务的所有者认证：

```text
GET /_agent-router/v1/agents/{agentId}/communication
```

返回连接启动状态与错误、最近 100 条 Inbox/Outbox 记录、Host 运行和待处理的原生交互；不返回平台 token。`started` 表示适配器启动成功，实时错误看 `error`，不能把它当成平台实时在线证明。配置或首次连接失败时先修正错误，再重启服务。

飞书个人授权沿用同一所有者认证：

```text
GET  .../communication/connections/{connectionId}/authorization
POST .../communication/connections/{connectionId}/authorization/begin     {}
POST .../communication/connections/{connectionId}/authorization/complete  {}
```

`begin` 返回完整授权链接和过期时间，device code 保存在私有目录；服务自动轮询，也可在用户确认后主动 `complete`。`status` 核对配置的 app 和扫码所有者，返回授权状态与 scope，不返回 token。这些接口不能用 worker 实例凭据调用。

## 接入检查

配置完成后执行只读检查，不开始收信、不发消息、不调用模型：

```sh
npm run channels:check -- /absolute/path/channels.json
# 服务已启动时同时核对 Router 连接状态
npm run channels:check -- /absolute/path/channels.json \
  --node https://router.example --owner-token-file /absolute/private/path/owner-token
```

输出逐项说明 `verified`、`needs_action`、`not_verified`。Host 验证服务和 runtime；飞书分别验证 bot 与个人授权；Telegram 验证 bot 和 webhook 冲突；邮件验证具体 inbox。微信不启动第二个收信进程，凭据文件检查后通过现有 Router 状态确认启动；Matrix 同样需要运行节点的状态。`verified` 仅表示该项说明中的检查通过，最终仍需本人发一条消息并收到回复，才能证明真实往返。存在 `needs_action` 时进程退出码为 1。

Host 发起原生提问时，在同一认证范围下调用：

```text
POST .../communication/calls/{callId}/result
{ "result": 原生 Agent 所需的 JSON }
```

答案格式沿用 Host 的原生交互契约，不转换成统一“同意/拒绝”。当前没有聊天按钮 UI；待处理交互需要通过该接口或已有 Host 产品入口解决，否则该轮继续等待。

## 恢复与发送语义

Router 保存收到的消息、原始回复路径、执行绑定与发送记录；重启后观察已有 Host run，不重新提交模型请求。保留 Router SQLite、Host 服务状态和原生 Agent 会话存储才能延续原会话。runtime、稳定 instructions、工具定义、实例或 Host 地址变更需要显式迁移/新 Agent，不能直接改配置后把旧上下文接到另一个执行环境。因此已有纯聊天 Host 绑定首次添加 `personalTools` 也需要迁移或新 Agent；日后 token 刷新或重新授权不改变工具定义，可以继续原会话。

工具调用按 Host run/call ID 保存执行与结果。已完成调用只重复回传保存的结果；CLI 写操作中断后不自动执行第二次。官方 CLI 的 `confirmation_required` 原样交给 Agent，只有所有者明确确认具体操作后才允许其加 `--yes`；Router 不代替 Agent 作业务决定。

Host 提交响应丢失或运行结果未知会标成 `unknown`，暂停该固定实例的领取，等待人工确认：

- 在 Host 中按 `sessionId` 找到原 run 后，调用 `POST .../communication/runs/{claimId}/reconcile`，正文 `{ "runId": "已核对的运行 ID" }`，继续观察该运行。
- 已确认执行停止、决定结束此轮时，调用 `POST .../communication/runs/{claimId}/close`，正文 `{}`。它结束 Router 工作记录；没有已知 run ID 时不能代替在 Host 中确认/停止原运行。

发送结果中 `accepted` 表示平台接口接受，不等同于用户已读。Matrix 使用稳定 transaction ID；Grove Mail 使用稳定幂等键，可以恢复发送。飞书、Telegram 和微信按分片保存发送回执，已确认的分片不会重复发送；未确认是否被平台接受的分片进入 `uncertain`，不盲目重发。飞书官方 SDK 的未知错误自动重试已关闭；原消息被撤回时，SDK 可能降级为同聊天的新消息。

飞书官方 Channel 内部异步分发消息并处理平台确认，业务处理异常不会回传成平台重投要求；Router 能持久化已进入回调的消息，并报告 `feishu_receipt_failed`，但不承诺磁盘故障窗口内端到端无损收信。Telegram、邮件、微信的游标在同步持久化收信之后推进；Matrix 收信与原游标共用事务。

这版只发送最终文字结果，长回复按渠道限制分片。飞书保留资源引用，尚未实现跨渠道附件下载并提交给 Host；音视频、主动通知、卡片流式更新和聊天交互 UI 不在本版范围。超过 24 KB 的文字输入会收到缩短提示，不会卡住后续收信。

## 已验证范围

`npm test` 覆盖跨渠道主会话、原路径回复、群聊隔离、游标、去重、分片回执、未知结果、实例撤销和重启恢复，以及个人身份校验、并发授权续接、用户 scope 恢复、工具执行账本和只读接入检查。现有 Matrix/A2A 回归测试继续运行。

真实 Agent Host 服务与 Codex 协议测试程序的集成验证：

```sh
npm run build
node scripts/verify-agent-host.mjs /absolute/path/agent-host
```

Host 项目需要先构建；脚本走其公开服务接口，验证托管 Router 装配、连续两轮、原生提问和原聊天回复，并用独立的 CLI 测试替身验证飞书工具请求/结果通过实际 Host HTTP broker 往返。测试不连接真实模型或 IM 账号；各平台真实凭据、应用权限、网络与账号可用性还需上线联调。
