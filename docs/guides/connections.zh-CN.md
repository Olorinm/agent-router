# 连接 Agent 渠道

[English](connections.md)

Router 负责账号、Agent 身份、渠道连接、消息归属和任务投递。云端 Agent 开通、Host 初始化和环境生命周期属于 [Mau](https://github.com/Olorinm/mau)。

```sh
agent-router login '@alice:agents.example'
agent-router agent-create helper
agent-router connection-options
agent-router channel-connect feishu
agent-router connection-check
```

由产品或运营者接入 Host，也可以让已有 worker 使用 Router 实例凭据领取任务。渠道按需连接：微信使用 `channel-connect weixin`，Telegram 使用 `channel-connect telegram --bot-token-file FILE`，Matrix 使用 `channel-connect matrix`。

飞书完成应用授权后即可接通消息，个人工具按需单独授权；仅聊天可加 `--messaging-only`。微信需要配对码时，使用 `channel-pair JOB_ID --pairing-code-file FILE`，然后 `channel-job JOB_ID`。`--no-wait` 返回连接任务。

飞书应用授权按官方 SDK 返回的 `expireIn` 等待，沿用 SDK 的缺省值；Router 不再另加十分钟的授权截止。最近的任务记录、凭据和连接配置跨重启保存；服务重启后未完成的授权轮询标记为中断，并提供恢复提示。官方 SDK 未提供可持久恢复应用注册轮询的令牌，因此不能用旧链接假装续接。

如果应用已经创建，但凭据未保存，使用开发者后台显示的 App ID 重新授权同一个应用，无需复制 App Secret：

```sh
agent-router channel-connect feishu --app-id cli_YOUR_EXISTING_APP_ID
```

重试时保留原来的 `--domain`、`--messaging-only` 选择。已保存凭据但绑定失败会复用凭据。创建结果不明时不会再次创建机器人，不要删 pending 标记绕过检查；指定已有应用恢复。已经分配给其他 Agent 的应用不可重复绑定。`channel-jobs` 可以查看失败原因和恢复提示。

`channels` 查看连接；`connection-check` 分开检查 Host、消息连接和个人授权，连接为空会明确报告；不会发送测试消息或调用模型。`channel-auth feishu begin` 和 `complete` 处理个人授权续期。完整参数及邮件连接见[英文指南](connections.md)。

独立 Router 可通过 `AGENT_ROUTER_CONNECTIONS_FILE` 指定私有 JSON 配置，目前只包含 `mailServices`。其他渠道无需此配置。Router 不加载云密钥或环境方案。持久保存 Router 状态目录及其中的 `connections/agents/`；替换连接前会停止旧消费者，并拒绝存在活动或未知执行结果的变更。

原有 `setup`、`setup-*`、`environment-*` CLI 和 `/setup` HTTP 路由已删除，没有兼容转发。
