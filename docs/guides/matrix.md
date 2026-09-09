# Matrix 接入与部署

> 当前默认产品流程是[一个账号管理多个 Agent](managed-agents.md)：人注册／登录 Matrix 账号，Agent 自动分配通信身份，运行机器导入实例凭证。下方单账号连接器命令仍用于原生 Matrix 互操作；托管实例无需再注册 Matrix 用户或运行本地 connector。


当前版本只使用 Matrix。独立域运营者部署 Synapse/PostgreSQL/Caddy；普通 Agent 注册到现有 homeserver，运行出站连接器。本项目不再提供旧 Router、JWT 联邦、RabbitMQ 或旧身份/任务迁移。

## 安装、注册、登录

普通用户先按[安装入口](install.md)安装发布包，无需编译：Go CLI 可通过 Homebrew 或原生压缩包安装，connector 使用同版本的 npm 发布文件。已有源码时可用 `sh scripts/install.sh --version 0.6.0` 安装两者。二进制本身不需要 Go/Node/npm；本地 connector 需要 Node.js 24。

源码开发时，用 Go 1.25+ 执行 `sh scripts/build-cli.sh`，再执行 `npm ci && npm run build`；通过 `./bin/agent-router connect --connector-runtime "$PWD/dist/matrix/index.js"` 启动匹配的通信服务，可用 `AGENT_ROUTER_NODE` 指定 Node 24 的路径。注册之前先从服务器运营者取得地址、账号或邀请码；下面的 `.example` 域名仅为占位符。

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
agent-router connect
```

默认由 Agent 通过 CLI 领取工作、提交结果，无需绑定 A2A 服务。连接器主动向 Matrix 发起 HTTPS 同步，无需公网入站。`connect` 是前台进程，可由操作者自己的进程管理器常驻运行。另一个终端或 Agent 工具进程使用下面的命令。完整操作见 [Agent 接入指南](agent-connect.md)。

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

## Agent 收发与处理

```sh
agent-router send '@editor:other.example' '请写一段介绍'
agent-router invites
agent-router invite-accept 'ROOM_ID'
# 不接受这个房间：
agent-router invite-reject 'ROOM_ID'
```

首次联系时正文先保存在发送端持久 outbox，接收方接受房间邀请后才发布。接受邀请不会自动添加联系人或允许执行。接收方通过 CLI 处理：

```sh
agent-router inbox
agent-router approve REQUEST_ID
agent-router claim --worker MY_AGENT_SESSION --wait 30
agent-router progress CLAIM_ID '正在写'
agent-router reply CLAIM_ID '介绍内容……'
```

`send` 默认立即返回本次请求的 `id` 和 `contextId`，`--wait 60` 可等待结果。`inbox` 显示待批准请求与已接收的工作；`claim` 返回输入、发送者、会话和领取凭据。Agent 在自己的环境中处理，随后用同一 `claimId` 提交进度与结果，连接器自动对应到发送方的原请求。`need-input` 请求补充信息，`fail` 返回失败，`work CLAIM_ID` 查看新输入与取消请求。

不传 context ID 时创建新房间；`conversation-open MATRIX_ID` 可显式创建。`conversations` 包含自己发起与接收的私聊。双方都可使用各自显示的 context ID，在同一个房间主动发消息或新任务。私聊关联保存到原生 `m.direct`；运行时上下文按房间和认证发送者关联。

```sh
agent-router conversations
agent-router send '@editor:other.example' '继续上一轮' --context-id CONTEXT_ID
agent-router send '@editor:other.example' '补充任务所需信息' --context-id CONTEXT_ID --task-id TASK_ID
agent-router get '@editor:other.example' TASK_ID
agent-router list '@editor:other.example'
agent-router cancel '@editor:other.example' TASK_ID
```

终态 Task 不能续写；在同一 context 创建新任务即可。重复提交同一操作时使用相同 `--message-id` 和内容。取消、补充输入和任务 ID 都属于原发起方的命名空间。接收方在工作中收到新输入后须再次领取，使用新凭据回复；取消正在处理的工作需要 Agent 先停止，再用 `cancelled CLAIM_ID` 确认。领取不会自动过期或交给另一 worker，重启后用同一 worker 名称恢复。外部 A2A 服务接受结果不明时保留 `uncertain`，不能据超时自动重复执行。

底层仍使用官方 A2A Task/Artifact/SSE，并由 Matrix 联邦传递。Agent 日常使用 `send` 即可。高级互操作命令 `say` 发送标准 `m.room.message` 文本，一般 Matrix 客户端可以读取它，但不会处理本项目的 Agent 请求事件。

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

新设备登录并运行连接器后，可恢复 Matrix 联系人、私聊和历史。通信缓存的首次同步不会自动运行历史任务；下载的旧请求标记为 `history_restored_without_execution_state`，需先核对执行结果。它不是自动迁移执行记录。

一个 Matrix 身份只在一台设备执行领取；其他登录设备不要重复处理同一请求。把执行身份搬到新机器仍需一致地转移连接器 SQLite 和 Agent 自身状态；绑定外部服务时还包括其任务数据库和真实模型 session。重新登录不会自动恢复丢失的模型历史。已有 CLI 工作或绑定后端时不能随意切换执行方式，避免把旧上下文交给另一个执行端。

同机多个 profile 应配置不同端口：

```sh
agent-router configure --connector-url http://127.0.0.1:8788 --profile second
agent-router connect --profile second
```

## 容器与官方 A2A 客户端

已有 A2A 服务可以在首次执行前用 `bind AGENT_CARD_URL --endpoint-token-file FILE` 选择，随后重启连接器。这会把执行交给该服务并禁用 CLI 领取。`bind` 验证官方 Agent Card；loopback 允许本地 HTTP，其他内网地址需显式 `--allow-local`。普通 CLI 接入不需要此步骤。

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
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/cli-work-check.mjs
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/client-check.mjs
```

检查 `172.30.247.0/24` 不与现有网络冲突。两个测试域的 CA 有效期 30 天；Synapse/数据库没有发布公网端口，两个网关只映射本机 18781/18782。CLI 领取验收创建独立合成账号，只启动两个连接器，不使用执行服务；原生客户端验收另行检查跨设备同步和可选 A2A 路径。验证后撤销测试设备令牌，原始证据保存在忽略提交的 state 中。

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
