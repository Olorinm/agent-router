# 用 CLI 开通 Agent

[English](onboarding.md)

登录已有 Router 服务，创建 Agent，选择执行端，再连接你想用的平台。
全程使用现有 Go CLI。需要构建当前源码，已发布的 v0.6.0 尚不包含这些命令。

## 第一次使用

管理员提供服务域名，以及账号或注册邀请。Router 和 Host 在服务器上运行，
你的电脑只需要 CLI。

```sh
agent-router login '@alice:agents.example'
# 如果服务开放注册：
# agent-router register agents.example alice --registration-token-file /private/invite

agent-router setup-options
agent-router setup helper --environment cloud-codex
```

密码在终端隐藏输入。`setup-options` 显示分配给你账号的环境方案。
`setup helper` 创建并选中 helper；已有同名 Agent 时复用它。
`--environment cloud-codex` 选择分配给账号的环境方案，自动分配环境并启动 Host。
聊天平台可选。环境生命周期与运营者配置见[云端开通说明](cloud-environments.zh-CN.md)。

## 选择连接的平台

```sh
agent-router channel-connect feishu
agent-router channel-connect weixin
agent-router channel-connect telegram --bot-token-file /private/telegram-token
agent-router channel-connect matrix
```

只执行需要的平台。也可以合成一步：
`agent-router setup helper --environment cloud-codex --channel feishu`。

- **飞书**：终端先显示官方应用配置二维码／链接，再显示个人授权二维码／链接。
  两步完成后启用个人工具。Lark 用 `--domain lark`；仅收发消息用
  `--messaging-only`。个人工具由 Host 调用。
- **微信**：微信扫描终端二维码；腾讯要求配对码时隐藏输入。
  支持腾讯 iLink 私聊。
- **Telegram**：先用 BotFather 创建机器人，token 从文件或隐藏提示输入。
  打开输出的一次性链接，在私聊中点击 Start，验证匹配的 `/start` 后绑定发送者。
  同一个 bot 不能同时有 webhook 或另一个轮询消费者。
- **Matrix**：使用 Agent 已有的服务身份连接原生聊天。不选择 Matrix 聊天入口时，
  节点内部仍使用 Matrix 作为身份与通信底座。

邮件使用管理员配置好的 Grove Mail 服务和已有邮箱：

```sh
agent-router channel-connect grove-mail \
  --mail-service mail --inbox helper@mail.example \
  --owner-email alice@example.org --api-key-file /private/mail-key
```

这个流程不等于 Gmail／Outlook 个人邮箱授权。已有 AgentMail 接入继续按
[渠道指南](channels.md)配置。秘密只从文件或终端隐藏输入读取，不接受明文 token 参数。

扫码默认等待完成，并立即打印任务 ID。脚本使用 `--no-wait` 获取 JSON。
关闭 CLI 后，只要 Router 仍在运行，可以继续：

```sh
agent-router channel-jobs
agent-router channel-job JOB_ID
agent-router channel-pair JOB_ID --pairing-code-file /private/pairing-code
```

扫码任务十分钟过期，不跨 Router 重启恢复；完成后的凭据和配置会持久保存。
已连接的平台不会被静默替换，需要管理员修改配置。飞书个人授权续期：

```sh
agent-router channel-auth feishu status
agent-router channel-auth feishu begin
# 同意链接中的授权后：
agent-router channel-auth feishu complete
```

## 检查和对话

```sh
agent-router channels
agent-router setup-check
```

检查确认配置、凭据访问和连接启动，不消费新消息、不发送测试消息、不调用模型。
最后在实际平台发一条消息，确认完整回复。

通过 CLI 对话时，选择另一个 Agent 作为发送方，因为 Agent 不能给自己发任务：

```sh
agent-router agent-create client
agent-router agent-use helper
agent-router contact-add alice/client@agents.example --allow-receive --allow-execution
agent-router agent-use client
agent-router send alice/helper@agents.example '你好' --wait 60
```

下一轮 `send` 带上返回的 `--context-id ID` 继续会话；未完成任务通过
`get ADDRESS TASK_ID` 查询。飞书个人工具限已绑定的所有者渠道会话，
A2A 调用许可不会自动获得你的个人账号权限。

朋友登录后执行 `setup client`，不需要 Host。你选中自己的执行 Agent，授权他的地址：

```sh
agent-router agent-use helper
agent-router contact-add bob/client@agents.example --allow-receive --allow-execution
```

朋友就能 `send alice/helper@agents.example '你好' --wait 60`。
他能使用授权的 Agent，不能管理你的 Host、渠道或账号。
没有自动执行许可时，继续使用原来的 `requests`、`approve`、`reject` 逐次处理。

## 管理员准备一次

先部署 [Router 节点](managed-agents.md#部署节点)，再按[云端开通说明](cloud-environments.zh-CN.md)
配置沙箱服务、镜像模板和按账号分配的环境方案。

```sh
npm ci
npm run build
sh scripts/build-cli.sh
npm run onboarding:init -- --out /private/router/onboarding.json \
  --environments-file /private/router/environments.json
```

设置 `AGENT_ROUTER_ONBOARDING_FILE`，挂载私有配置和沙箱密钥后重启服务。
用户只选择方案 ID，原生授权按账号提供，不能共享运营者的个人凭据。
渠道配置修改先停止旧消费者再原子替换，失败回滚；运行中或结果不确定的任务会阻止替换。
已有会话改变执行端需显式迁移。原固定 Host 开通入口和专用 Codex exec worker 已移除。

Router 数据库与 `state/agent-service/onboarding/` 一起备份。
每个 Agent 的配置和平台凭据存放在私有目录（0700）中的私有文件（0600）。
CLI 配置视图不返回 Host／渠道秘密，实例凭证不能管理渠道。

本地验证覆盖 CLI、协议模拟、账号隔离、私有文件、回滚，以及 A2A → Host → 回复。
真实平台账号与模型调用仍需后续联调。

配置接口在服务的鉴权前限流之外，再按账号限制每分钟 600 次请求。
