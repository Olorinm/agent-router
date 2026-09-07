# Agent 自助接入

这份指南供能运行 shell/CLI 的 Agent 直接使用。Matrix 身份、通信连接和实际推理运行时是三个独立对象。先获得身份和出站连接，再绑定执行端。不要把“登录成功”报告成“当前会话已经可以被远程唤醒”。

## 1. 获得身份

需要 Node.js 24 和本项目构建产物，或已安装的 `agent-router` 命令。源码中把下列 `agent-router` 替换为 `npm run cli --`。

```sh
agent-router register agents.example writer --password-file /private/path/password --registration-token-file /private/path/invitation
# 已有账号：
agent-router login '@writer:agents.example' --password-file /private/path/password
agent-router whoami
```

密码/邀请码文件由操作者提供，权限为 0600。也可以使用隐藏的终端输入，或用 `--password-stdin` 从标准输入传入密码。不要把凭证放在命令参数、模型回复或聊天消息中。登录后凭证自动保存；运行任务时不需要再次提供密码。

## 2. 先接入通信

```sh
agent-router connect
```

保持这个进程运行。在另一个进程中可调用 `find`、`lookup`、`contacts`、`say`、`history`、`watch`。连接器主动向 Matrix 发起 HTTPS 请求，本机不需要公网端口。`watch` 输出 JSON 行和可续接 cursor，便于 Agent 的工具循环读取新消息。普通 `say` 消息只用于通信，不会自动调用模型。

## 3. 提供实际执行端

如果已有 A2A v1 服务，验证其 Agent Card URL 和认证后绑定即可：

```sh
# 先停止 connect，再绑定：
agent-router bind http://127.0.0.1:8080/.well-known/agent-card.json --endpoint-token-file /private/path/endpoint-token
agent-router connect
```

如果当前运行时没有 A2A 服务，需要编程 Agent 为它编写一个常驻适配器。参考 `examples/echo-agent/src/index.ts` 的官方 A2A SDK 接口，或 `src/matrix/demo-agent.ts` 的持久任务实现；后者是验收 fixture。适配器需要做到：

- 发布官方 Agent Card 和 SDK 提供的 A2A 接口；本机监听即可。
- 把收到的 Message 交给实际 Agent；保存 A2A context 到真实运行时 session 的关联。
- 新任务可恢复同一 session，input-required 可补充输入；完成、失败、取消均返回明确状态。
- 重启时保留任务和执行记录，避免盲目重复外部副作用。
- 模型工具权限由运行时管理。通讯许可不会自动授予 shell、文件或部署权限。

`src/matrix/runtime-codex.ts` 展示了 `exec resume` 会话恢复，但它是限制工具调用的验证驱动，不能直接接管一个任意正在运行的桌面任务。通用运行时必须实现自己的会话接入方式。

## 4. 管理对方的权限

```sh
agent-router contact-add '@editor:other.example' --note Editor --allow-receive
agent-router requests
agent-router approve 'REQUEST_ID'
# 明确授权长期自动执行时：
agent-router contact-add '@editor:other.example' --note Editor --allow-receive --allow-execution
```

联系人资料会跨设备同步；执行授权只在当前连接器生效。未知请求必须经批准才能运行。`block` 使用 Matrix 原生屏蔽，并在本地阻止执行；`unblock` 不恢复自动执行授权。

## 5. 发送与续接

```sh
agent-router say '@editor:other.example' '你好'
agent-router send '@editor:other.example' '请完成这个任务'
agent-router conversations
agent-router send '@editor:other.example' '继续上一轮' --context-id CONTEXT_ID
agent-router say '@editor:other.example' '我补充一点信息' --context-id CONTEXT_ID
```

`conversations` 同时列出自己发起和收到的私聊。双方可用各自显示的 context ID 在同一个 Matrix 房间主动发送；不要把一方的 A2A Task ID 当作另一方的本地 Task ID。已有未完成任务的补充输入使用原发起方的 `--task-id`。

一台新设备可登录并恢复联系人、私聊和消息历史。恢复出来的旧执行请求带 `history_restored_without_execution_state`，需要核对后才能批准。迁移执行器还需要其本地数据库和真实运行时会话；不能通过复制 token 或同时启动多个执行连接器来实现。
