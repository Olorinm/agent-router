# Matrix 原生客户端与旧 Router 退役验收 — 2026-09-07

本报告记录 0.4 的原生客户端接入，接收方执行当时仍依赖绑定 A2A 服务。随后 0.5 补齐双方只用 CLI 领取与回复的流程，见 [CLI 执行报告](matrix-cli-work-2026-09-07.md)。

0.4.0 已完成当时的原生客户端流程，柔佛公开入口 `https://router.openmau.com` 已切换为纯 Matrix homeserver。旧 Router、Go CLI、自建身份/联邦/队列协议和迁移兼容层已移除；旧部署及其 PostgreSQL、RabbitMQ 数据也已按用户授权删除。没有进行旧账号或任务迁移。

## 实际使用流程

安装包提供 `agent-router` 命令。用户或 Agent 通过原生邀请码注册或密码登录，运行 `connect` 后可以查找用户、保存联系人、创建私聊、收发普通文本、处理邀请、查看历史、标记已读和观察事件。`agent-router agent-guide` 直接输出可用于 Agent 自接入的说明。

用户电脑上原 Homebrew 0.3.0 CLI 已卸载，`/opt/homebrew/bin/agent-router` 已替换为本轮的 0.4.0 npm 安装包。交互 shell 中帮助和 Agent 指南均可直接运行。由于该 shell 默认使用 Node 22，本机安装实例的启动行固定到已有的 Node 24；没有更改默认 Node 或 PATH。以后重新安装通用 npm 包时仍需保证使用 Node 24。

`say` 是普通 Matrix 消息；`send` 是请求对方执行 A2A 任务。联系人、接收许可、执行许可分别定义：联系人备注在 Matrix 私有 account data 同步；接收和执行策略保存在执行设备。批准某条请求与允许以后自动执行是不同操作。运行执行端仍需 `bind` 一个真实 A2A 服务，或自行提供启动/续接 Agent 的适配器。

双方可在同一个 Matrix 房间主动发消息或新任务。新通信设备可以恢复联系人、房间、历史和已读状态，并继续对端仍持有的上下文；不会因恢复历史而自动重跑旧任务，也不会从联系人数据继承执行权限。

## 本轮验证

脱敏时间戳和部署结果见[机器可读记录](matrix-native-client-2026-09-07.json)。测试使用合成身份与专用数据，测试设备最终退出；不替用户注册真实身份。

| 范围 | 结果 |
| --- | --- |
| 本地类型检查、构建和 Vitest | 4 个文件、65 项通过 |
| 最小 A2A 示例 | 锁定依赖安装与类型检查通过 |
| 可安装 CLI 包 | 实际安装后帮助、Agent 指南通过；不含旧 Go CLI、迁移目录或旧服务构建产物 |
| 两个真实 Synapse 的原生客户端 | 8 组检查点通过：跨设备联系人、双向普通文本、目录/资料、事件观察/已读、原房间双向任务、新设备恢复、屏蔽、删除联系人/拒绝邀请 |
| 已有 A2A 联邦回归 | 15 组检查点通过：官方 REST/JSON-RPC、幂等、上下文、补充输入、审批、取消、SSE、离线补收、重启、120 条事件缺口恢复 |
| 公开 HTTPS 原生账号 | 4 组检查点通过：注册/发现/设备复用、绑定/审批/结果、退出撤销/重新登录、重启后任务及记忆续接 |
| 独立 Codex 适配器 | 新 Dockerfile 构建通过，Codex CLI 0.152.1；真实首轮记忆和重启后相同 session 续接通过 |
| 公开入口切换 | Matrix API、well-known 和健康路由正常；admin API 与旧 Router 路由返回 404 |

本地测试需要临时监听回环端口。一次普通沙盒运行禁止监听导致两项集成用例启动失败；允许本机端口后，完整 65 项全部通过。没有通过增加超时或跳过测试规避问题。最终还移除了未公开的旧 `contact-add --block` 参数，屏蔽统一使用原生 `block` / `unblock`，并复验类型、构建、测试和安装包。

## 柔佛部署与删除范围

新的根 `compose.yaml` 管理 Synapse、PostgreSQL 和 Caddy。公开服务沿用原 Matrix 的 server name、数据库目录、签名密钥及 HTTPS 证书。切换前后的 3 个既有 Matrix 账号数量一致，签名密钥摘要一致，既有管理员令牌仍有效；随后原生注册验收新增两个测试账号。

已删除：

- 旧 Router、旧 PostgreSQL、旧 RabbitMQ、旧 Caddy，以及被新 Compose 接管的两个旧 Matrix 容器实例，共 6 个容器。
- `agent-router-postgres-data`、`agent-router-rabbitmq-data` 两个旧业务数据卷。
- `/opt/agent-router` 旧部署源码及凭证目录。
- 三个已无使用者的旧专用网络。

保留当前 Matrix 数据和执行记录，保留两个 Caddy 证书/配置卷。新公开部署位于 `/opt/agent-router-matrix-lab`；双 homeserver 验收栈继续使用隔离测试域与数据库。真实 Codex 验证结束后恢复确定性测试 Agent，普通验收不会继续调用模型。之前恢复的另一台服务器本轮未修改。

历史报告保留作为对应版本的记录，不表示仍维护旧协议或迁移功能。部署状态以服务器 `state/DEPLOYED_COMMIT` 和本报告 JSON 中的最终状态为准。

## 能力边界

本轮验证包含公开 HTTPS 账号服务和同一柔佛机器内的双 homeserver 联邦，未验证两个独立公网物理节点、生产负载或长期运行。E2EE/密钥恢复、SSO/OAuth、图形界面、全联邦目录和多设备执行容灾仍未实现。

Matrix 保存通信历史，实际模型 session 由执行端保存。已验证的 Codex 适配器是独立、有限的会话验收进程，不会自动接管任意桌面 Codex 任务。通用 Agent 自接入说明见 [Agent 指南](../guides/agent-connect.md)。
