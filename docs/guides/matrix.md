# Matrix 接入与部署

新链路使用 Matrix 通信、官方 A2A 调用执行端、本地连接器保存权限和任务关联。普通 Agent 只需要一个 Matrix 账号和一个出站连接器；独立域运营者部署 Synapse 等兼容 homeserver。用户不必为每个 Agent 部署 Synapse。

## 注册、登录和连接 Agent

注册、登录、设备和令牌由 homeserver 的原生 Matrix API 管理。CLI 使用官方 Matrix SDK；不另外创建 Router 密码或账号系统。需要 Node.js 24 和可访问的 homeserver。

```sh
npm ci
npm run build
npm run matrix -- register agents.example writer
# 已有账号则直接登录：
npm run matrix -- login '@writer:agents.example'
npm run matrix -- whoami
```

密码在终端中隐藏输入；注册会再次确认密码。服务器要求邀请码时，CLI 再提示输入邀请码，由服务器校验。使用域名或完整 Matrix ID 时会先读取 `/.well-known/matrix/client`；显式提供 `https://...` 则直接使用该服务地址。`discover SERVER` 可以检查服务发现和登录方式。

登录成功后，设备 token 和本机网关凭证自动保存在 `~/.config/agent-router/matrix/default/session.json`，文件权限为 `0600`、目录为 `0700`，不保存密码。可用 `MATRIX_CONFIG_DIR` 指定根目录，用 `--profile NAME` 选择另一个 Agent 的独立配置；这些凭证采用本地私有文件存储。

绑定本地或远端 A2A 执行端，然后启动：

```sh
npm run matrix -- bind http://127.0.0.1:8080/.well-known/agent-card.json --endpoint-token-file secrets/agent
npm run matrix -- connect
```

`bind` 先验证 Agent Card 和接口所在 origin，不会执行任务。loopback 执行端自动允许本地连接；其他内网执行端需加 `--allow-local`。只发送请求时可省略 `bind`。`connect` 在前台运行，Ctrl-C 停止；账号已登录不代表执行器已经上线。同一 profile 只运行一个连接器，更换后端仍需显式处理已有上下文。

另一个终端可直接使用 `doctor`、`contacts`、`send` 等命令，自动读取同一 profile，无需复制 token。多 Agent 在同一设备上运行时，为每个 profile 配置不同端口：

```sh
npm run matrix -- configure --connector-url http://127.0.0.1:8788 --profile editor
npm run matrix -- connect --profile editor
npm run matrix -- doctor --profile editor
```

停止连接器后，`logout` 会调用 Matrix `/logout` 撤销当前设备登录，再移除本地的 access/refresh token。联系人、任务历史、网关凭证和后端绑定保留；重新 `login`、`connect` 后继续使用原上下文。正在运行的连接器会阻止其他进程修改该 profile 的登录或绑定；进程异常退出后可以恢复。不要让多个 profile 同时执行同一个 Matrix 身份。

自动化支持 `--password-stdin` 或 `--password-file PATH`，邀请码使用 `--registration-token-file PATH`；不要把密码或 token 当作参数值。服务器提供 refresh token 时，连接器通过官方 SDK 自动续期并原子保存新凭证。密码登录、`m.login.registration_token` 和 `m.login.dummy` 注册验证已接入；当前 CLI 尚未接入 SSO/OAuth、邮箱或 CAPTCHA 的交互。额外注册验证需在兼容 Matrix 客户端完成，之后只有服务器支持密码登录时才能使用本 CLI 的 `login`。仅支持 SSO/OAuth 的服务器尚不能通过这个登录入口接入；CLI 会明确报出不支持，不会跳过服务器要求。

## 使用预配置 token 接入 homeserver

容器及已有自动化仍可使用环境变量配置。需要 Matrix 账号的 access token，以及一个可选的 A2A v1 执行端。连接器通过 HTTPS 出站同步，A2A 执行端可以只在本机监听。没有执行端时，连接器仍可作为发送任务的网关。

```sh
npm ci
npm run build
cp .env.matrix.example .env.matrix
```

编辑 `.env.matrix` 中的 homeserver URL、Matrix ID 和执行端 URL。把三类凭证分别放入指定文件，权限设为 `0600`：Matrix access token、自己生成的至少 16 字符的网关 API token、执行端 bearer token。不要把它们写进房间消息或提交到 Git。

启动连接器：

```sh
node --env-file=.env.matrix dist/matrix/index.js
```

另一个终端中，以下命令都使用同一份私有配置：

```sh
node --env-file=.env.matrix dist/cli/matrix.js doctor
node --env-file=.env.matrix dist/cli/matrix.js status
node --env-file=.env.matrix dist/cli/matrix.js contact-add '@writer:other.example' --note 'Writer'
node --env-file=.env.matrix dist/cli/matrix.js send '@writer:other.example' '请写一段简介'
```

仅添加联系人时，接收和执行许可都为 `ask`。双方可以分别设置：

```sh
# 接受此联系人的房间邀请，消息进入请求箱，仍需逐条批准执行。
node --env-file=.env.matrix dist/cli/matrix.js contact-add '@writer:other.example' --allow-receive
# 明确允许自动接收和自动执行。
node --env-file=.env.matrix dist/cli/matrix.js contact-add '@writer:other.example' --allow-receive --allow-execution
```

`contact-add` 是覆盖更新：省略许可选项会将相应许可改回 `ask`。`--block` 阻止接收及执行。`MATRIX_ALLOWED_SENDERS` 只用于首次配置时同时授予两项许可，不会覆盖已经保存的联系人选择。

以下示例使用环境变量配置；已登录的 profile 可以将命令前缀替换为 `npm run matrix --`。显式选择 profile 时使用其账号、网关和后端，不继承其他环境配置的 token 或 `MATRIX_ALLOWED_SENDERS` 授权。

陌生联系人第一次联系时，用户先看到房间邀请。接受后，发送方才将首条请求从持久 outbox 发布到 Matrix；请求进入接收方的请求箱，批准后才调用 Agent：

```sh
node --env-file=.env.matrix dist/cli/matrix.js invites
node --env-file=.env.matrix dist/cli/matrix.js invite-accept 'ROOM_ID'
node --env-file=.env.matrix dist/cli/matrix.js requests
node --env-file=.env.matrix dist/cli/matrix.js approve 'REQUEST_ID'
# 或 reject 'REQUEST_ID'
```

从列表完整复制 ID，包括 JSON 形式请求 ID 中的括号和引号。CLI 会正确编码路径。授权接收、保存联系人、批准执行是独立操作。

`send` 默认等待完成或需要补充输入，并输出官方 A2A JSON；`--detach` 返回已排队任务。任务和上下文 ID 会显示在输出中。后续新任务使用相同 `--context-id`；补充某个未完成任务时同时指定 `--task-id`：

```sh
node --env-file=.env.matrix dist/cli/matrix.js send '@writer:other.example' '继续上一轮的风格' --context-id CONTEXT_ID
node --env-file=.env.matrix dist/cli/matrix.js send '@writer:other.example' '补充的信息' --context-id CONTEXT_ID --task-id TASK_ID
node --env-file=.env.matrix dist/cli/matrix.js get '@writer:other.example' TASK_ID
node --env-file=.env.matrix dist/cli/matrix.js list '@writer:other.example'
node --env-file=.env.matrix dist/cli/matrix.js cancel '@writer:other.example' TASK_ID
```

重复提交同一操作时，保持 `--message-id` 和消息内容一致。终态任务不能续写；应在同一上下文下创建新任务。离线取消会持久排队；等待超时不表示取消已经成功，也不会撤回取消请求。

## 官方 A2A 客户端

网关地址为 `http://127.0.0.1:8787/agents/{URL 编码的 Matrix ID}/`，末尾的 `/` 必须保留。Card 位于其下的 `.well-known/agent-card.json`。Card 和所有任务接口需要网关 API token。

CLI 优先使用 `CONNECTOR_URL`，然后使用 `PUBLIC_BASE_URL`，否则连接本机 8787。所选地址应与 Card 中接口的 origin 一致；CLI 不会将网关凭证转发到其他 origin。

使用官方 SDK 时，给 `DefaultAgentCardResolver` 和传输工厂都配置带凭证的 `fetchImpl`。示例可直接参考 `src/cli/matrix.ts`。提供 REST、JSON-RPC、SSE、get/list/subscribe/cancel；push notifications 和 extended Card 不支持。该 Card 描述路由能力，当前没有同步远端 Agent 技能目录。

## 容器运行连接器

使用 `deploy/matrix/compose.connector.yaml`。预先创建 `state/matrix`，使其可由容器 UID 1000 写入；凭证文件也必须可由该 UID 读取。把本机执行端 URL 改为容器可达地址，例如 `http://host.docker.internal:8080/.well-known/agent-card.json`。允许访问本机执行端只对显式配置的固定 origin 生效。

```sh
docker compose -f deploy/matrix/compose.connector.yaml up -d --build
```

网关只映射到宿主机 loopback。如果需要外部 A2A 客户端访问，部署自己的 HTTPS 入口并设置对应 `PUBLIC_BASE_URL`；不要将 bearer token 放在未加密的公网连接上。连接器不需要公网入站才能接收 Matrix 消息。

## 可复现的双 homeserver 验收

`deploy/matrix/compose.lab.yaml` 包含两套独立 Synapse/PostgreSQL、两个连接器和两个确定性 A2A 执行端。它使用私有测试域名、专用 CA 和 Docker 网络，不是公网域名部署模板。测试证书有效期为 30 天。联邦与客户端均验证 TLS 证书；房间内容未做端到端加密。

Linux/Docker 主机上先用 Node.js 24 和 OpenSSL 生成测试配置。若主机没有 Node，可在其他机器运行初始化，再将本项目及 `state/matrix-lab` 安全复制到测试主机。

```sh
npm run matrix:lab:init
sudo chown -R 991:991 state/matrix-lab/synapse-a state/matrix-lab/synapse-b
sudo chown 991:991 state/matrix-lab/tls/a.key state/matrix-lab/tls/b.key
sudo chown -R 1000:1000 state/matrix-lab/connector-a state/matrix-lab/connector-b \
  state/matrix-lab/agent-a state/matrix-lab/agent-b state/matrix-lab/secrets-a state/matrix-lab/secrets-b
docker compose -f deploy/matrix/compose.lab.yaml build connector-a
docker compose -f deploy/matrix/compose.lab.yaml up -d pg-a pg-b synapse-a synapse-b
# 等两台 Synapse 健康后注册专用测试身份；重复运行会保留已有令牌。
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/lab-register.mjs
docker compose -f deploy/matrix/compose.lab.yaml up -d agent-a agent-b connector-a connector-b
bash scripts/matrix/lab-verify.sh
```

检查 Docker 网络 `172.30.247.0/24` 不与现有网络冲突。若更改网段，应同时修改生成配置的 `ip_range_whitelist`。验收容器拥有读取测试密钥和写证据的权限；运行中的连接器不具备这些额外权限。所有数据库和 homeserver 端口保持在 Docker 网络内，网关仅映射宿主机 `127.0.0.1:18781/18782`。

结果保存在 `state/matrix-lab/verification.json`，包含合成任务标识。脚本会停启连接器和测试 Agent；不要对生产身份或生产任务运行。它不删除卷或覆盖密钥。若镜像下载需代理，可以用官方 `crane pull` 获取并校验镜像后 `docker load`，无需改变已有 Docker daemon 的网络配置。

## 真实 Codex 会话恢复验证

基础验收不需要模型账户。可选的 `compose.codex.lab.yaml` 从现有 `examples/codex-employee` 镜像复用官方 CLI，在另一份可写会话目录中执行。经操作者授权，将 Codex 认证配置置于 `state/matrix-lab/codex-b/home/auth.json`，目录和文件归 UID 1000、权限分别为 `0700/0600`。不要复制其他人的会话历史。

通过 `CODEX_RUNTIME_IMAGE` 指定已有镜像，按需设置 `MATRIX_CODEX_HTTPS_PROXY` 和 `MATRIX_CODEX_EGRESS_NETWORK`，然后：

```sh
docker compose -f deploy/matrix/compose.lab.yaml -f deploy/matrix/compose.codex.lab.yaml build agent-b
docker compose -f deploy/matrix/compose.lab.yaml -f deploy/matrix/compose.codex.lab.yaml up -d agent-b
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/lab-check.mjs codex-first
docker compose -f deploy/matrix/compose.lab.yaml -f deploy/matrix/compose.codex.lab.yaml restart agent-b connector-b
docker compose -f deploy/matrix/compose.lab.yaml run --rm check node scripts/matrix/lab-check.mjs codex-resume
```

第一轮只提供随机标记；第二轮不重复该标记，要求恢复记忆，并核对两轮的运行时 session ID 完全相同。驱动持久化 `A2A context → Codex session`，通过官方 `exec resume` 恢复，不使用 `--ephemeral`。该示例提供只读沙箱；它仍是验收 fixture，不是完整生产 Agent 的工具授权系统。

## 独立域部署与旧系统迁移

### 启用原生注册登录服务

`deploy/matrix/compose.homeserver.yaml` 提供独立 Synapse/PostgreSQL。它使用正式 DNS server name、正常联邦校验和原生注册邀请码；不使用验收环境的 `.test` 域名、私有 CA 或放宽的限流配置。

```sh
node scripts/matrix/homeserver-init.mjs agents.example
sudo chown -R 991:991 state/matrix-homeserver/synapse
# operator 容器使用 UID 0；从其他机器复制 state 时，保留属主和权限。
docker compose -f deploy/matrix/compose.homeserver.yaml up -d --wait
docker compose -f deploy/matrix/compose.homeserver.yaml run --rm admin bootstrap
docker compose -f deploy/matrix/compose.homeserver.yaml run --rm admin invite first-user 1 24
```

管理员工具需要本项目的 `agent-router-matrix:lab` 镜像，可用 `Dockerfile.matrix` 构建。使用普通用户运行初始化时，应让 `secrets`、`invitations` 及 state 根目录归 operator 的 UID 0，Synapse 目录归 UID 991，并保持 `0700/0600` 权限。数据库端口不对外发布；`MATRIX_EDGE_NETWORK` 指定现有反向代理网络，默认与 Router 的 `agent-router-edge` 共用。

邀请码通过 Synapse admin API 创建，写入 `state/matrix-homeserver/invitations/first-user`，默认一次使用、24 小时有效；命令不会打印邀请码或管理凭证。将邀请码交给对应用户即可注册，不需要把管理员共享密钥交给用户。

若复用已有 Router HTTPS 域名，`deploy/matrix/Caddyfile.router-with-matrix` 为 Matrix 客户端、联邦、服务发现增加路由，其他路径仍交给 Router；`/_synapse/admin/*` 不公开。应用前先备份并验证实际运行的 Caddy 配置。单文件 bind mount 若已指向旧 inode，需要修正挂载，不能仅凭宿主机同名文件判断加载结果。独立部署时可按同样路径规则配置自己的 HTTPS 反向代理。

账号入口部署后，用一个允许两次注册的测试邀请码运行 `scripts/matrix/auth-check.mjs`：设置 `MATRIX_TEST_HOMESERVER=https://agents.example`、`MATRIX_TEST_INVITATION_FILE` 和可写的 `MATRIX_AUTH_CHECK_DIR`。脚本创建合成账号、启动本地测试 Agent 和连接器，验证原生注册、登录、权限审批、令牌撤销、重新登录后的任务历史与会话恢复，最后退出测试设备登录。

### 旧身份与历史

独立域运营者部署标准 homeserver、数据库、TLS 和 Matrix 域名发现；两个 homeserver 可位于不同机器或云服务商。参考 [Synapse 安装文档](https://element-hq.github.io/synapse/latest/setup/installation.html) 配置实际域名及受信任证书。测试环境的 `.test`、私有 CA、较高限流阈值和内网白名单不能原样作为公网配置。

新链路不再需要自定义 Router JWT 联邦或跨域 RabbitMQ。旧 `writer@domain` 注册身份、认证令牌和任务历史不会自动变成 Matrix 账号。为新会话显式选择 Matrix 身份；旧任务继续在原路径查询、完成或取消。原 Go CLI、`compose.yaml` 和 `Dockerfile` 留作旧部署兼容；Node 默认入口已经指向 Matrix，旧入口为 `npm run start:legacy`。

在实际公网域名、账号归属、历史迁移和活跃任务处理明确之前，不替换原线上入口，不同时从两条路径执行同一项工作。备份时要同时保留 homeserver 数据库/签名密钥、Matrix token、连接器 SQLite 数据库（包括一致的 WAL 快照）以及运行时会话目录。一个 Matrix 身份只运行一个主动执行连接器；不能靠复制数据库或令牌实现多机容灾。

还未实现 E2EE、联系人图形界面、全局目录、自动旧数据迁移，以及接受结果不明时的自动核对。`requests` 会显式列出 `uncertain`；先核对执行端实际状态，不能据超时重新执行有副作用的操作。完整协议和边界见 [Matrix 应用事件规范](../spec/matrix-events-v1.md)。
