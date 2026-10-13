# 执行环境里的工具

[English](worker-tools.md) | **简体中文**

把 CLI 装在 Agent 实际运行的环境里，由它的原生终端工具直接调用。Router 继续
负责收消息和回消息，执行环境保存工具、账号配置和文件，无需先搭建 MCP 服务。

[Codex worker 示例](../../examples/codex-worker/README.md)预装官方
`@larksuite/cli` 1.0.97。官方技能随二进制内置，通过 `lark-cli skills read` 读取，
和安装版本一致。

## 接入账号

完成托管 worker 的部署准备后，在 `examples/codex-worker` 目录运行：

```sh
docker compose -f compose.managed.yaml up -d --build
docker compose -f compose.managed.yaml exec worker lark-cli --version
docker compose -f compose.managed.yaml exec worker lark-cli skills read lark-shared
```

Compose 默认设置 `WORKER_LARK_DIR=/state/lark`，并设置官方 CLI 的配置、数据目录
环境变量。它们都在持久化卷里。独立运行 worker 时，把 `WORKER_LARK_DIR` 设为
持久化绝对路径；手动管理 CLI 时，还要设置 `LARKSUITE_CLI_CONFIG_DIR=<目录>/config`
和 `LARKSUITE_CLI_DATA_DIR=<目录>/data`。

可以复用已经连接聊天渠道的应用。把应用密钥保存在管理员的私有文件里，通过
标准输入交给 CLI，避免放进镜像、命令参数、仓库或聊天：

```sh
docker compose -f compose.managed.yaml exec -T worker \
  lark-cli config init --app-id '<应用 ID>' --app-secret-stdin --brand feishu \
  < secrets/feishu-app-secret
docker compose -f compose.managed.yaml exec worker lark-cli config default-as bot
docker compose -f compose.managed.yaml exec worker lark-cli auth status --json --verify
```

机器人身份直接使用应用权限，无需个人扫码。调用时明确带 `--as bot`。
接收群成员请求的共享 worker 使用机器人身份，不放入群成员的私人账号。

要使用个人日历、文档等资源，在**该用户的私人执行环境**里配置应用并授权：

```sh
docker compose -f compose.managed.yaml exec worker \
  lark-cli auth login --domain im --no-wait --json
# 打开返回的 verification_url；由 Agent 协助时，也应生成并展示二维码。
# 用户确认授权后，用本次返回的 device_code 完成登录：
docker compose -f compose.managed.yaml exec worker \
  lark-cli auth login --device-code '<device-code>'
docker compose -f compose.managed.yaml exec worker lark-cli config default-as user
docker compose -f compose.managed.yaml exec worker lark-cli auth status --json --verify
```

按需选择 `im`、`docs`、`calendar` 等业务域。本机或 Router 上的个人授权不会自动
同步到 worker。重启、迁移时同时保留配置目录和数据目录，后者可能包含令牌及其
加密材料。

## 验证是否可用

```sh
docker compose -f compose.managed.yaml exec worker \
  lark-cli im +chat-messages-list --as bot --chat-id '<群 ID>' --page-size 5
```

退出码为 0 且 `ok: true` 才是成功。机器人缺权限时去应用后台开通；个人身份缺
权限时走用户授权，不通过切换身份绕过错误。worker 会提示 Agent 先读官方技能，
并保留 CLI 对具体操作的确认要求。

机器人读取**群历史**还需要 `im:message.group_msg`（获取群组中所有消息），以及
`im:message`、`im:message:readonly` 或旧版历史读取权限之一。能收到 @消息不代表
能读取群历史；需要在应用后台开通并发布这项权限。见[官方历史消息接口说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)。

渠道任务现在带上平台会话、消息、发送者及引用消息 ID。飞书的平台会话 ID 就是
`--chat-id`，Agent 可以据此查询近期消息和引用话题。它按需读取历史；不会自动把
整个群历史塞进上下文，也没有改变会话分组规则。普通回复仍由 Router 送回。

重启 worker 后再读一次，确认登录状态仍有效。同一用户的多个 Agent 可以复用
工具镜像和执行环境；不同用户使用各自的配置和数据卷。本示例没有实现自动分配
每用户 VM 或多用户环境管理。

## 升级已有的定制 worker

使用 `Dockerfile.tools` 和 `--build-arg WORKER_IMAGE=<已有镜像>` 安装 CLI，保留
原有 worker 实现；再将示例中的 `WORKER_LARK_DIR` 环境传递和技能提示接进现有
worker。先备份 Compose 和持久化状态，使用新镜像标签部署，保留旧镜像以便回滚。
镜像根目录只读时，通过重建镜像更新工具，不在运行中的容器里全局升级。
