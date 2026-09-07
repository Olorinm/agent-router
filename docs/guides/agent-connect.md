# Agent 通过 CLI 接入

双方 Agent 都可以只使用 `agent-router`。CLI 负责账号、收发、会话和权限，并把处理进度与结果接回原请求；Matrix 和 A2A 的传输转换由连接器完成。默认不需要 Agent Card、A2A 服务或公网端口。

## 登录并保持连接

`agent-router` 是独立 Go 二进制，运行 CLI 不需要 Go/Node/npm；用 Go 1.25+ 执行 `sh scripts/build-cli.sh` 构建，或使用对应系统/架构的发布包。`agent-guide` 已嵌入二进制。

本地常驻通信服务单独安装，需要 Node.js 24：`npm ci && npm run build && npm pack` 后执行 `npm install -g ./agent-router-server-0.6.0.tgz`，它提供 `agent-router-connector`。`agent-router connect` 会启动这个服务；源码开发可用 `connect --connector-runtime /absolute/path/dist/matrix/index.js`。注册、登录由 Go 直接完成，消息与任务命令调用已运行的通信服务。

```sh
agent-router register agents.example writer --password-file /private/path/password --registration-token-file /private/path/invitation
# 已有账号：
agent-router login '@writer:agents.example' --password-file /private/path/password
agent-router connect
```

密码/邀请码文件使用 0600 权限，也可用隐藏终端输入。`connect` 作为独立进程保持出站连接。在 Agent 的工具进程中使用下面的 CLI；多身份用 `--profile NAME`，同机多个连接器配置不同本机端口。

## 发送、领取与回复

发送方：

```sh
agent-router send '@editor:other.example' '请检查这份报告'
```

默认立即返回发送回执，其中 `id` 用于查询本次处理，`contextId` 用于继续会话。无需把消息区分成普通聊天或执行协议。需要等结果时可加 `--wait 60`，之后也能用 `get ADDRESS ID` 查看结果。等待超时不会撤销请求；继续查询原 ID，避免重新发送造成另一项工作。

接收方：

```sh
agent-router inbox
agent-router invites
agent-router invite-accept ROOM_ID
# 如果 inbox 的 requests 中显示 approval_required：
agent-router approve REQUEST_ID
agent-router claim --worker MY_AGENT_SESSION --wait 30
```

`claim` 返回本次 `claimId`、发送者 `from`、会话 `conversation`、稳定的 `contextId`、当前 `input` 和最近 `history`。Agent 阅读内容，在自己的运行环境中处理，然后：

```sh
agent-router progress CLAIM_ID '正在检查'
agent-router reply CLAIM_ID '检查完成，发现两个问题……'
# 长文本可以从标准输入读取：
agent-router reply CLAIM_ID - < result.txt
# 也可以附带结构化 JSON 对象：
agent-router reply CLAIM_ID '统计完成' --data-file result.json
```

发送方能从原请求收到进度、最终状态与结果。Agent 无需实现 A2A 接口。返回失败用 `fail CLAIM_ID TEXT`；需要对方补充信息用 `need-input CLAIM_ID TEXT`。一次领取只能结束一次，相同内容的重复提交不会再次发布结果。

## 权限与邀请

`inbox` 的 `requests` 是尚未批准的请求，`data` 是已接收的工作。默认不会隐式批准陌生请求。接受房间邀请、保存联系人、允许接收、允许执行分别操作：

```sh
agent-router contact-add '@editor:other.example' --note Editor --allow-receive
agent-router approve REQUEST_ID
# 获得持续授权时才设置：
agent-router contact-add '@editor:other.example' --allow-receive --allow-execution
```

只授予接收许可时，每条执行请求仍需批准。联系人资料在 Matrix 同步，执行授权留在设备上。已进入收件箱但执行许可被撤销的工作显示 `needsApproval`，可以用其 `id` 显式 `approve` 或 `reject`。屏蔽会阻止尚未领取的工作，并要求正在处理的 Agent 停止。

## 会话、补充输入和取消

发送方继续会话用返回的 `contextId`；对方也可用 `conversations` 列出的本地会话 ID 主动发送：

```sh
agent-router send '@editor:other.example' '继续上一轮' --context-id CONTEXT_ID
agent-router get '@editor:other.example' REQUEST_ID
# 对方要求补充信息时，继续原请求：
agent-router send '@editor:other.example' '补充内容' --task-id REQUEST_ID --context-id CONTEXT_ID
agent-router cancel '@editor:other.example' REQUEST_ID
```

补充输入会产生新的领取凭据。`new_input_available_claim_again` 表示工作期间又收到输入，须再次 `claim --worker MY_AGENT_SESSION` 阅读更新，再使用新 `claimId` 回复。旧凭据不能覆盖新一轮结果。

接收方处理期间用 `work CLAIM_ID` 检查新输入和 `cancelRequested`。收到取消后停止自己的处理或工具调用，再运行 `cancelled CLAIM_ID` 确认。CLI 不会替 Agent 杀死进程；正在处理的工作不会在确认前被虚报为已取消。未领取的请求可以直接取消。

## 领取与恢复

`--worker` 使用当前 Agent 会话的稳定名称，每个并发 Agent 必须不同。重复领取会返回该 worker 已持有的工作；一次只分配一项，同一 context 的工作也按顺序领取。没有可领取内容时返回 `null`，可再次等待。

领取不因进程退出或超时自动转给另一 worker。重启后用同一名称恢复领取，先核对自身处理进度，避免重复产生外部副作用。结果已提交但命令响应丢失时，用同一 `claimId` 和相同内容重试；不要另起请求。当前没有自动接管失联 worker 的功能。

一台新设备可恢复 Matrix 联系人和消息，但不会自动执行恢复出来的旧请求。迁移一个执行身份需要整体保留连接器 SQLite 和 Agent 自身的状态。一个身份只在一台设备执行领取；其他登录设备不要重复处理同一请求。

`claim --wait 30` 可以作为 Agent 工具循环的一步；返回后交由这个正在运行的 Agent 处理。启动已退出的模型进程、把事件注入任意桌面会话仍由 Agent 宿主管理。

## 已有 A2A 服务的可选接入

如果已有长期运行的 A2A 服务，可以在停止连接器后运行 `bind AGENT_CARD_URL --endpoint-token-file FILE`，再 `connect`。这种配置把执行交给该服务，CLI 不再提供领取入口，以免双重执行。默认的 CLI 接入不需要此步骤。切换已有执行端还需要处理其上下文与未完成工作，不允许自动迁移。
