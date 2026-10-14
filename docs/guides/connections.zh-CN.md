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

飞书默认完成应用和个人授权；仅聊天可加 `--messaging-only`。微信需要配对码时，使用 `channel-pair JOB_ID --pairing-code-file FILE`，然后 `channel-job JOB_ID`。`--no-wait` 返回连接任务；连接任务不跨服务重启保存，已建立的连接和凭据持久保存。

`channels` 查看连接；`connection-check` 检查配置和连接，不会发送测试消息或调用模型。`channel-auth feishu begin` 和 `complete` 处理个人授权续期。完整参数及邮件连接见[英文指南](connections.md)。

独立 Router 可通过 `AGENT_ROUTER_CONNECTIONS_FILE` 指定私有 JSON 配置，目前只包含 `mailServices`。其他渠道无需此配置。Router 不加载云密钥或环境方案。持久保存 Router 状态目录及其中的 `connections/agents/`；替换连接前会停止旧消费者，并拒绝存在活动或未知执行结果的变更。

原有 `setup`、`setup-*`、`environment-*` CLI 和 `/setup` HTTP 路由已删除，没有兼容转发。
