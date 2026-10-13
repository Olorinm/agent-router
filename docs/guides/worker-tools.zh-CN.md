# 执行环境里的工具

[English](worker-tools.md) | **简体中文**

把工具装进 Agent Host 使用的环境镜像。原生 Agent 通过终端调用 CLI，通过自身的
MCP 能力连接 MCP 服务。Router 负责消息、渠道凭据和回复。

## 准备环境

按照[云端开通指南](https://github.com/Olorinm/mau/blob/main/docs/environments.zh-CN.md)发布环境方案，在镜像中安装并固定
工具版本。飞书使用官方 `@larksuite/cli`，通过 `lark-cli skills read lark-shared`
读取随版本提供的说明。

在 Host runtime 的 `env` 中设置 `LARKSUITE_CLI_CONFIG_DIR` 和
`LARKSUITE_CLI_DATA_DIR`，指向私有持久目录。两个目录都要保留，data 可能包含
令牌加密材料。凭据通过方案的私有文件注入，不能写入源码、镜像或聊天。

运营者可以在已有环境中执行命令：

```sh
agent-environment exec --config /private/providers.json --provider cloud \
  --id ENVIRONMENT_ID -- lark-cli --version
```

管理命令需要显式使用与 Host runtime 相同的配置／数据目录环境变量；
`agent-environment exec` 不自动继承 runtime 配置。这是运营工具，普通用户通过
`mau setup` 和渠道命令开通。

## 接入并验证飞书

在执行环境内使用 `lark-cli config init` 配置应用，应用密钥从私有文件通过
`--app-secret-stdin` 输入。适用时复用渠道已有应用，然后执行：

```sh
lark-cli config default-as bot
lark-cli auth status --json --verify
lark-cli im +chat-messages-list --as bot --chat-id '<chat-id>' --page-size 5
```

共享群聊 Agent 使用 bot 身份。私人执行环境需要个人资源时，运行
`lark-cli auth login --domain im --no-wait --json`，完成官方授权，再以返回的
`device_code` 运行 `lark-cli auth login --device-code '<device-code>'`。
电脑或 Router 上的授权不会自动传入执行环境。按实际需求选择业务域，后续命令
始终显式沿用同一身份。

退出码为零且 `ok: true` 才算成功。读取群历史需要 `im:message.group_msg` 和消息
读取权限；只接收 @消息不够。参见[官方接口权限说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)。

渠道任务带有平台会话、消息、发信人和引用消息 ID。飞书会话 ID 可用于 `--chat-id`，
Agent 据此补充相关历史；普通回复仍由 Router 发回。遵循官方 CLI 的确认要求，
权限不足时不能切换身份绕过。

暂停并恢复环境后重复验证，确认数据持久化。不同用户使用独立凭据目录。工具升级
通过新镜像和保留持久数据的环境迁移完成。
