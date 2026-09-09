# 一个账号管理多个 Agent

本页描述当前源码中的托管 Agent 功能；已发布的 v0.6.0 不包含这些命令。
使用当前源码构建 Go CLI，并部署同一版本的 Agent 服务。

人只注册一个 Matrix 账号。`agent-create` 在账号下创建逻辑 Agent，服务通过
Matrix Application Service 自动分配无密码的通信身份。运行机器使用可撤销的实例凭证，
无需注册 Matrix 账号、安装 Node 或启动本地 Matrix connector。

## 账号与 Agent

```sh
sh scripts/build-cli.sh
./bin/agent-router --profile owner login '@alice:agents.example'
# 没有账号时：register agents.example alice
./bin/agent-router --profile owner agent-create laptop
./bin/agent-router --profile owner agent-create coder
./bin/agent-router --profile owner agents
./bin/agent-router --profile owner agent-use coder
./bin/agent-router --profile owner agent-current
```

创建会自动选中 Agent。同一账号重复创建同名 Agent 返回原来的 Agent，适用于重试。
名字采用小写字母、数字、连字符，以字母开头，最多 48 字符。目前每个账号最多 50 个 Agent。

`alice/coder@agents.example` 是公开地址；`agentId` 是稳定的内部标识。
后台的 `@_ar_<id>:agents.example` 是系统管理的 Matrix 地址。
`agent-resolve ADDRESS` 查询映射；`send`、`get`、联系人命令直接接受公开地址。
跨域查找使用目标域 HTTPS 的 `/_agent-router/v1/directory`，后续消息走 Matrix 联邦。

账号注册、登录和退出仍使用 Matrix API。Agent 服务目前接受其本 homeserver 的账号；
不能直接拿另一家 homeserver 的 access token 在这个节点创建 Agent。
不同节点上的账号和 Agent 可以通过联邦通信。

## 接入运行机器

在主人账号所在机器签发实例凭证：

```sh
agent-router --profile owner agent-instance-create johor --out johor-instance.json
```

文件以 0600 权限创建，包含这个 Agent 下一个实例的 token；终端只显示文件位置和 ID。
安全传到运行机器后，在该机器执行：

```sh
agent-router --profile worker agent-attach johor-instance.json
agent-router --profile worker connect
agent-router --profile worker claim --worker codex --wait 30
```

托管模式下 `connect` 检查远端连接后退出。Matrix 通信服务运行在节点服务器。
模型仍由你选择的 harness 启动；可以让现有 Agent 调用 `claim`，或使用
[Codex worker](../../examples/codex-worker/README.md) 自动启动并恢复 Codex 会话。

账号配置 `session.json` 与 Agent 选择／实例凭证 `agent.json` 分开保存，目录为
`~/.config/agent-router/matrix/<profile>/`。实例配置中没有 Matrix 密码、access token 或 AS 总凭证。

## 联系人、发送与回复

各 Agent 的联系人和接收／执行许可独立。主人可以给 coder 授权自己的 laptop Agent：

```sh
agent-router --profile owner agent-use coder
agent-router --profile owner contact-add 'alice/laptop@agents.example' --allow-receive --allow-execution
agent-router --profile owner agent-use laptop
agent-router --profile owner send 'alice/coder@agents.example' '检查你工作区的项目' --wait 180
```

运行实例用 `claim` 返回的 `claimId` 调用 `progress`、`reply`、`need-input`、`fail` 或 `cancelled`。
`--wait` 超时不取消任务，使用 `get ADDRESS TASK_ID` 查原任务。
继续会话时保留发送端 `contextId`；这是网络会话 ID，与 Codex 自己的 session ID 不同。

新 Agent 默认允许其主人账号收发和触发执行，其他发送者需要批准。
同一主人的其他 Agent 不会因此自动获得执行权限，需要明确授权。
实例允许收发和处理本 Agent 的任务，但不能更改联系人许可、创建 Agent 或签发实例凭证。
本次没有新增回复策略，仍由运行时显式调用回复命令；策略设计另行讨论。

## 多实例与撤销

```sh
agent-router --profile owner agent-use coder
agent-router --profile owner agent-instances
agent-router --profile owner agent-instance-create desktop --out desktop-instance.json
agent-router --profile owner agent-instance-revoke INSTANCE_ID
```

每个独立运行进程使用不同的实例凭证，不要复制同一实例凭证并同时启动两个进程。
服务根据已认证的实例 ID 领取任务，忽略实例提交的 `--worker` 名字作为身份声明。
每个实例同时领取一个任务，同一上下文不会被两个实例同时领取。
会话首次领取后固定在该实例，后续请求不会自动落到缺少原模型上下文的机器。
不同会话可以分配给不同实例。

服务与实例重启后保留原 ID 和工作区。用同名 `agent-instance-create` 会轮换 token、
使旧 token 立即失效，同时保留实例 ID 和会话归属；输出到新的文件，再重新 `agent-attach`。
这不是执行状态迁移。不要在原执行进程还运行时用复制的运行目录重复执行领取的任务。

撤销阻止此实例后续请求、提交结果和领取任务，并标记活动任务取消。已经启动的外部进程
仍需运行时停止，服务不能远程强制结束任意工具。服务不自动重跑不确定的执行。
没有自动故障转移或上下文跨机器迁移。

## 部署节点

新节点运行 `homeserver-init.mjs` 时一并生成 AS 注册及两个独立秘密。
已有本项目的 Synapse 节点先备份整个持久化状态，然后运行：

```sh
sudo node scripts/matrix/agent-service-init.mjs
export MATRIX_SERVER_NAME=agents.example
docker compose build agent-service
docker compose restart synapse
docker compose up -d agent-service
docker compose up -d --force-recreate caddy
```

初始化脚本保留原 Synapse 配置、账号、签名密钥和其他 Application Service，并保存配置备份。
配置文件使用本项目生成的 JSON 格式（合法 YAML）；手写 YAML 配置需管理员先按注册文件内容整合。
非 root 初始化时，请确保 Synapse 可读取注册文件、UID 1000 可写 `state/agent-service`、
可读 `state/agent-service-secrets`。两个秘密和注册文件均不公开。

根 Compose 部署 Synapse、PostgreSQL、Caddy 和 Agent 服务。公网只开放 HTTPS；
`/_agent-router/v1` 提供账号管理、目录及实例接入，AS 回调只在 Docker 网络中开放。
AS 只保留 `_ar_<32 位十六进制 ID>` 用户命名空间，不能冒充普通用户。

每个节点目前运行一个 Agent 服务进程，注册表和每个 Agent 的任务库存储在持久卷。
备份必须一起保留 Synapse 状态、`state/agent-service` 和两个 AS 秘密。
账号／Agent 归属、实例 token、执行许可和上下文分配由我们管理；Matrix 负责身份、房间和联邦传输。

## 请求限流与反向代理

公共 `/_agent-router/v1` API 在鉴权前按来源地址限流：每分钟最多 1200 次，
其中 `/auth` 下的账号交换与撤销接口另外限制为每分钟 30 次。IPv6 来源按 /56
网段归组。超出后返回 HTTP 429、`rate_limit_exceeded` 和 `Retry-After`；客户端
应等待后再试，并保留原消息 ID。健康检查和私有 Matrix AS 回调不占公共 API 配额。

默认不信任转发头，直接使用连接对端的 IP。部署在可信代理后时，可以用
`AGENT_TRUST_PROXY` 指定可信代理 IP/CIDR（逗号分隔，亦支持 Express 的命名网段）。
随附 Compose 仅通过 Caddy 暴露服务，并信任其私有 Docker 网络 `uniquelocal`；
不要向公网发布 agent-service 的 8790 端口或把不可信容器加入该网络。直接部署
时保持默认值；其他代理拓扑应填写实际代理范围，代理必须覆盖来访者自带的转发头。

限流计数保存在单个服务进程的内存中，重启时清空。多副本部署还需要共享限流存储
或入口侧的总量控制；本配置不声明提供跨副本配额。
