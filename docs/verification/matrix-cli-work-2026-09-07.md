# CLI 执行闭环验收 — 2026-09-07

0.5.0 补齐双方只使用 `agent-router` 的执行流程。默认连接器保存待处理工作，Agent 用 CLI 领取、处理、回传进度和结果，不需要自己实现或绑定 A2A 服务。Matrix 继续负责账号、消息持久化和联邦；连接器把 CLI 操作接到已有 A2A Task/Artifact 和响应关联上。

## 使用体验

双方登录后各自运行 `agent-router connect`。发送方使用 `send ADDRESS TEXT`，立即得到请求 ID 与会话 ID，可用 `get` 查询或在发送时加 `--wait 60`。陌生请求需要接受房间邀请并批准执行；加联系人、允许接收和允许执行仍分别操作。

接收 Agent 使用：

```sh
agent-router inbox
agent-router approve REQUEST_ID
agent-router claim --worker MY_AGENT_SESSION --wait 30
agent-router progress CLAIM_ID '正在处理'
agent-router reply CLAIM_ID '处理结果'
```

`claim` 返回发送者、输入、最近历史、会话与领取凭据。Agent 在自己的运行环境中完成工作，`reply` 自动把结果交回原请求。补充信息用 `need-input`，失败用 `fail`，查看更新与取消用 `work`，停止后用 `cancelled` 确认。完整流程见 [Agent 指南](../guides/agent-connect.md)，安装后也可运行 `agent-router agent-guide`。

## 验证结果

脱敏时间戳和结果见 [机器可读记录](matrix-cli-work-2026-09-07.json)。

| 范围 | 结果 |
| --- | --- |
| 类型检查、构建和本地测试 | 5 个文件、79 项通过，其中 14 项覆盖 CLI 工作领取与集成 |
| 双 Synapse、双方仅使用 CLI | 5 组通过：审批与独占领取/进度/幂等回复，同会话双向请求与补充输入，重启恢复领取，取消确认，离线补收与失败回传 |
| 原有 A2A 服务接入回归 | 15 组通过：REST/JSON-RPC、去重、上下文、补充输入、审批、SSE、取消、离线/重启和历史缺口恢复 |
| 原生 Matrix 客户端回归 | 8 组通过：联系人与本地许可分离、双向文本/原房间请求、目录/资料、事件/已读、新设备恢复、屏蔽与删除联系人/拒绝邀请 |
| CLI 分发 | 0.5.0 安装包实际安装验证通过；用户电脑的命令已更新，交互 zsh 下帮助与 Agent 指南通过 |
| 公开 Matrix 入口 | 客户端版本与 well-known 发现返回 200，服务仍位于柔佛 |

CLI 专项测试通过两个真实 Synapse 的原生账号和联邦运行；专用测试进程只启动双方连接器，未启动或绑定 A2A 执行服务器。测试脚本代表接收 Agent 调用 CLI 提交确定性结果，测试结束后撤销设备令牌。原有 A2A 回归另行使用执行服务。此前真实 Codex 会话恢复的证据保留在 [0.4 报告](matrix-native-client-2026-09-07.md)，本报告不把脚本回复计为真实模型执行。

## 持久化与行为约束

领取、输入版本、回复幂等凭据和待发布结果均写入 SQLite。稳定 worker 名称可恢复丢失的领取响应或重启前的工作；不同 worker 不能同时领取同一工作，同一 context 的活动工作串行领取。领取不会超时后自动转交，防止在执行结果不明时重复产生外部副作用。

新输入到达时，旧领取凭据不能提交最终结果；原 worker 再次领取后获得更新内容和新凭据。相同回复重试返回原回执，不重复发布；过大结果在提交前拒绝，原领取仍可改用较小内容或文件引用。

执行许可在领取前再次检查。未领取工作被屏蔽后拒绝，处理中工作收到停止要求。执行中取消须由 Agent 停止并确认，连接器不会宣称自己已杀死外部进程。已存在 CLI 工作或外部执行上下文时，不允许直接切换到无关执行端。

## 部署与边界

本轮更新柔佛 `/opt/agent-router-matrix-lab` 的连接器源码和测试镜像，保留既有 Matrix 数据、签名身份和公开 homeserver。部署版本由服务器 `state/DEPLOYED_COMMIT` 记录并与源文件摘要核对。原先恢复的另一台服务器未修改。

本机 CLI 使用已有 Node 24 启动，未改变用户默认 Node 或 PATH。使用原有 worktree，本轮未新增 worktree 或参考仓库；提交保留在本地工作分支，未推送或合并到主分支。

这次补齐的是 Agent 通过 CLI 收发和处理的闭环。Agent 宿主负责模型启动、会话续接和工具执行；`claim --wait` 向正在运行的 Agent 提供输入，不会自动唤醒任意已退出的桌面会话。每个身份只在一台设备执行领取。双 homeserver 在同一柔佛主机上，未据此验证独立公网物理节点或执行容灾。E2EE/密钥恢复、SSO/OAuth 等既有边界不变。
