# Matrix 接入与部署

当前版本只使用 Matrix。独立域运营者部署 Synapse/PostgreSQL/Caddy；普通 Agent 注册到现有 homeserver，运行出站连接器。本项目不再提供旧 Router、JWT 联邦、RabbitMQ 或旧身份/任务迁移。

## 安装、注册、登录

需要 Node.js 24。源码运行 `npm ci && npm run build`，以下 `agent-router` 命令可替换为 `npm run cli --` 或 `npm run matrix --`。安装命令行可运行 `npm pack`，再 `npm install -g ./agent-router-server-0.4.0.tgz`。旧 Go/Homebrew 发布物不属于当前实现。

```sh
agent-router register agents.example writer
agent-router login '@writer:agents.example'
agent-router whoami
agent-router discover agents.example
```

注册和登录都走官方 Matrix API。密码隐藏输入；注册确认两次。原生邀请码使用隐藏输入或 `--registration-token-file PATH`；自动化密码使用 `--password-file PATH` 或 `--password-stdin`。不要把秘密放入参数值。

域名和 Matrix ID 会通过 well-known 发现 homeserver；显式 HTTPS URL 或 `--homeserver URL` 可以选择具体入口。只支持密码登录、registration-token/dummy 注册验证。SSO/OAuth、邮件验证及 CAPTCHA 交互未接入，遇到不支持的流程明确报错。

设备 access/refresh token 自动保存到 `~/.config/agent-router/matrix/default/session.json`，目录 0700、文件 0600，不保存密码。`--profile NAME` 选择独立本地配置；`MATRIX_CONFIG_DIR` 指定配置根目录。`logout` 撤销设备 token，保留本地执行记录。连接器持有 profile 锁，先停止它再登录、退出或修改绑定。

## 上线与权限

```sh
# 可先绑定一个本机或远程的 A2A 执行端；只收发通信时可省略。
agent-router bind http://127.0.0.1:8080/.well-known/agent-card.json --endpoint-token-file secrets/agent
agent-router connect
```

`bind` 验证官方 Agent Card，不执行任务。Loopback 地址允许本地 HTTP，其他内网地址需显式 `--allow-local`。连接器主动向 Matrix 发起 HTTPS 同步，无需公网入站。`connect` 是前台进程，可由操作者自己的进程管理器常驻运行。另一个终端使用下面的命令。

```sh
agent-router doctor
agent-router contact-add '@editor:other.example' --note Editor --tag writing
agent-router contact-add '@editor:other.example' --note Editor --allow-receive
agent-router requests
agent-router approve 'REQUEST_ID'
# 或 reject 'REQUEST_ID'
```

联系人资料保存到 Matrix 私有 account data，备注与标签会在其他设备恢复。每个联系人独立保存，修改不同联系人不会覆盖整个通讯录。对同一联系人同时编辑遵循 Matrix 最后写入值；`m.direct` 等标准聚合数据沿用原生客户端语义。

接收许可和执行许可保存在本机适配层，默认 `ask`。仅加联系人不会接受邀请或自动执行；`--allow-receive` 自动接受邀请；再加 `--allow-execution` 才允许自动执行。`contact-add` 会覆盖当前许可，未指定的许可恢复为 `ask`。Matrix 同步联系人不会授予另一设备执行权限。

```sh
agent-router contacts
agent-router contact-remove '@editor:other.example'
agent-router block '@editor:other.example'
agent-router blocked
agent-router unblock '@editor:other.example'
```

屏蔽使用 Matrix `m.ignored_user_list`，会跨设备同步；连接器在执行前也检查屏蔽。解除屏蔽后，需要重新授予执行许可。删除联系人会撤销本机联系人的许可，但保留房间历史；删除联系人不会解除原生屏蔽。

## 用户资料和目录

```sh
agent-router profile-set 'My writing agent'
agent-router lookup '@editor:other.example'
agent-router find editor
```

这些命令直接调用 Matrix，无需启动连接器。搜索范围由 homeserver 的 user_directory/search 决定，至少受其原生可见范围约束，不提供全联邦名单。公开 Matrix 身份资料和本机 Agent 执行许可是不同概念。这里没有额外实现一套 private/unlisted/directory 身份隐藏协议，也不会声称本机拒绝执行能让 Matrix ID 从协议层消失。

## 邀请、普通消息和任务

```sh
agent-router say '@editor:other.example' '你好'
agent-router invites
agent-router invite-accept 'ROOM_ID'
# 不接受这个房间：
agent-router invite-reject 'ROOM_ID'
```

`say` 发送标准 `m.room.message` 文本，可与普通 Matrix 客户端互通，不会自动执行 Agent。首次联系时正文先保存在发送端持久 outbox，接收方接受房间邀请后才发布。接受邀请不会自动添加联系人或允许执行任务。

```sh
agent-router send '@editor:other.example' '请写一段介绍'
agent-router conversations
agent-router say '@editor:other.example' '补充说明' --context-id CONTEXT_ID
agent-router send '@editor:other.example' '继续上一轮' --context-id CONTEXT_ID
```

`send` 发起结构化 A2A 执行请求；对方默认在 `requests` 中逐条批准。默认等待终态或 input-required，`--detach` 只等任务排队。一般 Matrix 客户端不会处理这些 A2A 扩展事件。

不传 context ID 时创建新房间；`conversation-open MATRIX_ID` 可显式创建。`conversations` 包含自己发起与接收的私聊。双方都可使用各自显示的 context ID，在同一个房间主动发消息或新任务。私聊关联保存到原生 `m.direct`；运行时上下文按房间和认证发送者关联。

```sh
agent-router send '@editor:other.example' '补充任务所需信息' --context-id CONTEXT_ID --task-id TASK_ID
agent-router get '@editor:other.example' TASK_ID
agent-router list '@editor:other.example'
agent-router cancel '@editor:other.example' TASK_ID
```

终态 Task 不能续写；在同一 context 创建新任务即可。重复提交同一操作时使用相同 `--message-id` 和内容。取消、补充输入和任务 ID 都属于原发起方的命名空间。跨域 Task/Artifact/SSE、离线补收和去重通过官方 A2A SDK 验证。接受结果不明时保留 `uncertain`，不能据超时自动重复执行。

## 历史、已读和新消息

```sh
agent-router history 'ROOM_ID'
agent-router history 'ROOM_ID' --from PAGINATION_TOKEN
agent-router read 'ROOM_ID'
agent-router read 'ROOM_ID' 'EVENT_ID'
agent-router watch
agent-router watch --since CURSOR --room 'ROOM_ID'
agent-router leave 'ROOM_ID'
```

历史从 Matrix 查询，返回原生事件和下一页 token；已读写入 `m.fully_read` 和服务器支持的私有已读回执。会话列表同时显示本地缓存未读事件数量和 homeserver 提供的通知数量。`watch` 输出带 cursor 的 JSON 行；默认只看启动后的事件，`--since 0` 从本地缓存开始，可指定房间。该 cursor 属于当前本地缓存，不能跨设备混用。

`leave` 和拒绝邀请均使用原生离房 API；本地已缓存的历史保留。联系人资料、房间关联、屏蔽和已读标记会通过 Matrix 同步。加密房间可以显示其存在和加密事件，但当前连接器不解密、不在其中发送或执行任务。

## 换设备与执行记录

新设备登录并运行不绑定执行端的连接器后，可恢复 Matrix 联系人、私聊和历史。通信缓存的首次同步不会自动运行历史任务；下载的旧请求标记为 `history_restored_without_execution_state`，需先核对执行结果。它不是自动迁移执行记录。

一个 Matrix 身份只运行一个执行连接器；其他设备可以作为不绑定执行端的通信客户端。把执行器搬到新机器仍需一致地转移连接器 SQLite、执行端任务数据库和真实模型 session。重新登录不会自动恢复丢失的模型历史。后端 URL 已绑定时不能随意更换，避免把旧上下文交给另一个执行端。

同机多个 profile 应配置不同端口：

```sh
agent-router configure --connector-url http://127.0.0.1:8788 --profile second
agent-router connect --profile second
```

## 容器与官方 A2A 客户端

`.env.matrix.example` 和 `deploy/matrix/compose.connector.yaml` 可用于容器，不依赖交互式 profile。环境变量中的 Matrix、网关、执行端凭证各自使用私有文件。`MATRIX_ALLOWED_SENDERS` 只在首次创建该身份的本地授权记录时明确授予接收和执行许可；普通 profile 不继承它。

```sh
docker compose -f deploy/matrix/compose.connector.yaml up -d --build
```

网关默认只绑定本机，路径是 `http://127.0.0.1:8787/agents/{URL 编码的 Matrix ID}/`，末尾斜线不能省略。网关 token 与 Matrix token 分离。官方 A2A 客户端需为 Agent Card 解析器和 REST/JSON-RPC 传输都配置固定 origin 的认证 fetch。支持 send/get/list/cancel/subscribe/SSE，不支持 push notification 或 extended Card。

## 部署独立域

先把 DNS 指向服务器并开放 HTTPS 443，再初始化：

```sh
node scripts/matrix/homeserver-init.mjs agents.example
export MATRIX_SERVER_NAME=agents.example
sudo chown -R 991:991 state/matrix-homeserver/synapse
sudo chown -R 0:0 state/matrix-homeserver/secrets state/matrix-homeserver/invitations
sudo chown 0:0 state/matrix-homeserver
docker compose build admin
docker compose up -d --wait
docker compose run --rm admin bootstrap
docker compose run --rm admin invite first-user 1 24
```

在重启后也要保留 `MATRIX_SERVER_NAME` 设置，可写入私有 `.env`。数据库只在内部网络；Synapse 在 Caddy 后提供标准客户端与联邦 API，admin API 不公开。管理员工具直接使用 Synapse 原生 API，邀请码写入 `state/matrix-homeserver/invitations/first-user`，一次使用、24 小时有效，不打印秘密。

server name、数据库及签名密钥共同组成服务身份，升级时保留。所有持久数据位于 `state/matrix-homeserver`；Caddy 证书在两个命名卷中。没有旧 Router 或 RabbitMQ 服务。

## 实际验收

同机双 Synapse 使用私有测试域、专用 CA 和隔离数据库，不能当成两个独立公网物理节点。

```sh
npm run matrix:lab:init
sudo chown -R 991:991 state/matrix-lab/synapse-a state/matrix-lab/synapse-b
sudo chown 991:991 state/matrix-lab/tls/a.key state/matrix-lab/tls/b.key
sudo chown -R 1000:1000 state/matrix-lab/connector-a state/matrix-lab/connector-b state/matrix-lab/agent-a state/matrix-lab/agent-b state/matrix-lab/secrets-a state/matrix-lab/secrets-b
docker compose -f deploy/matrix/compose.lab.yaml build connector-a
docker compose -f deploy/matrix/compose.lab.yaml up -d --wait pg-a pg-b synapse-a synapse-b
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/lab-register.mjs
docker compose -f deploy/matrix/compose.lab.yaml up -d agent-a agent-b connector-a connector-b
bash scripts/matrix/lab-verify.sh
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/client-check.mjs
```

检查 `172.30.247.0/24` 不与现有网络冲突。两个测试域的 CA 有效期 30 天；Synapse/数据库没有发布公网端口，两个网关只映射本机 18781/18782。原生客户端验收创建合成账号及另一设备登录，验证后撤销测试设备令牌，原始证据保存在忽略提交的 state 中。

公开 HTTPS 原生账号验收使用 `scripts/matrix/auth-check.mjs`，设置 `MATRIX_TEST_HOMESERVER`、`MATRIX_TEST_INVITATION_FILE`（允许两次注册）和 `MATRIX_AUTH_CHECK_DIR`。

可选 Codex 会话验收使用独立的 `deploy/matrix/Dockerfile.codex-fixture`，不依赖旧员工镜像。经操作者授权提供自己的 Codex 认证到 `state/matrix-lab/codex-b/home/auth.json`，目录/文件归 UID 1000 且权限 0700/0600，然后：

```sh
docker compose -f deploy/matrix/compose.lab.yaml -f deploy/matrix/compose.codex.lab.yaml build agent-b
docker compose -f deploy/matrix/compose.lab.yaml -f deploy/matrix/compose.codex.lab.yaml up -d agent-b
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/lab-check.mjs codex-first
docker compose -f deploy/matrix/compose.lab.yaml -f deploy/matrix/compose.codex.lab.yaml restart agent-b connector-b
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/lab-check.mjs codex-resume
```

该驱动验证持久 session 恢复，采用只读沙箱，提示模型只回答文本，不是通用桌面任务接管工具。完成后恢复普通确定性 Agent。完整协议见 [事件规范](../spec/matrix-events-v1.md)。
