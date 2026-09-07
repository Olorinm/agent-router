# Matrix 原生账号接入验收 — 2026-09-07

历史记录：下文描述当时仍保留旧 Router 的账号接入阶段。当前已删除旧服务和兼容路径，见 [0.4 原生客户端与退役验收](matrix-native-client-2026-09-07.md)。

原生 Matrix 注册、密码登录、设备令牌管理已经接入 CLI，并在火山柔佛的 `https://router.openmau.com` 完成实际注册和任务闭环。账号由 Synapse 管理；本项目保存设备凭证、连接器状态与 A2A 执行端绑定，不另建密码数据库。原 Router 业务入口继续运行，旧身份、任务和历史没有自动迁移。

## 用户操作

在 Matrix 工作目录安装依赖并构建后，用运营者提供的一次性邀请码注册。已有 Matrix 账号可以直接登录。

```sh
npm run matrix -- register router.openmau.com yourname --registration-token-file state/matrix-registration-invitation
# 已有账号：npm run matrix -- login '@yourname:router.openmau.com'
npm run matrix -- whoami
npm run matrix -- connect
```

密码隐藏输入，注册时确认两遍。注册结果已经包含本设备的登录，不需要再复制 access token。`connect` 在前台运行；另一个终端可以使用联系人、请求箱和任务命令。要让这个身份执行任务，先用 `bind` 绑定可访问的 A2A Agent Card，操作见 [接入指南](../guides/matrix.md)。注册账号不会自动绑定当前桌面 Agent 会话。

本次提供给所有者的邀请码仅一次使用，创建后 24 小时有效，保存在工作目录下忽略提交的 `state/matrix-registration-invitation`，权限 `0600`。邀请码不写入报告或 Git。公开注册由 Synapse 的原生 registration token 验证，管理员 API 不对外开放。

登录信息默认保存在 `~/.config/agent-router/matrix/default/session.json`，不保存密码。停止连接器后 `logout` 会撤销服务器令牌；重新登录保留联系人、任务历史、网关凭证、后端绑定和本地上下文关联。

## 检查结果

脱敏时间戳与检查点见 [机器可读记录](matrix-accounts-2026-09-07.json)。

| 检查 | 结果 |
| --- | --- |
| 本地 TypeScript 类型检查与构建 | 通过 |
| 本地 Vitest | 15 个文件、78 项测试通过，其中原生账号 11 项 |
| 原生邀请码注册、域名发现、身份验证、重复登录复用设备 | 公开 HTTPS 实测通过 |
| 保存登录 → 绑定 A2A → 连接 → 接收许可与逐条审批 → 返回任务结果 | 通过 |
| 连接器运行时阻止修改 profile；退出撤销服务器 token | 通过 |
| 退出、重新登录、连接器重启后联系人、任务历史与同一上下文记忆保留 | 通过 |
| 本机终端交互登录、whoami、logout；密码不回显、token 不打印 | 通过 |
| 官方 SDK refresh token 轮换及原子持久化 | 本地协议测试通过 |
| 原双 Synapse 联邦套件 | 双向 REST/JSON-RPC、去重、会话、输入续接、取消、审批、SSE、离线与重启、120 条事件缺口恢复通过 |
| 最后错误信息脱敏修正 | 11 项账号测试、类型检查、构建通过；最终云端连接器 ready |

原生账号端到端验收使用两个合成账号和确定性执行端，结束后退出两个测试设备；没有替用户注册真实身份。真实 Codex 会话恢复沿用 [此前已完成的验收](matrix-2026-09-07.md)，本轮未重复调用模型。公开 homeserver 的跨独立物理节点联邦、生产负载和长期离线未在本轮覆盖。

## 部署与配置

- 在柔佛现有 `/opt/agent-router-matrix-lab` 内新增独立 Synapse 1.160.0 / PostgreSQL 17.11，使用正式 server name `router.openmau.com`、独立数据库与签名密钥。不要在使用后更改 server name。
- 两个公共 homeserver 容器与八个已有联邦验收容器并行运行。数据库和 Synapse 没有直接发布端口；Caddy 提供正常 HTTPS 客户端、联邦及 well-known 路由。
- Caddy 的原单文件挂载指向旧 inode。首轮配置应用检查失败后已自动恢复，随后通过验证后的标准输入加载配置，并只重建 Caddy 容器修复持久挂载；证书卷保留。公开 Matrix 路由及原 Router 健康检查均再次通过。
- 原 Router、RabbitMQ 和 PostgreSQL 的容器 ID、启动时间、重启次数与健康状态保持不变。之前恢复的另一台服务器本轮未修改。
- 最终连接器及确定性执行端镜像为 `sha256:6296d343e5a56e96a98778865dc4ed68780ca3efcf0621cde65ef176e539db8c`；部署源码版本记录在服务器 `state/DEPLOYED_COMMIT`。旧镜像标签和迁移备份保留。

可复现脚本为 `scripts/matrix/auth-check.mjs`；独立 homeserver 初始化、原生管理 API 和 Caddy 模板见 [部署指南](../guides/matrix.md)。本轮未新增 worktree 或临时参考仓库，继续使用既有 Matrix worktree。

## 当前边界

这是可用的命令行接入流程。SSO/OAuth、额外注册验证界面、图形客户端和 E2EE 尚未集成；本机凭证使用权限受限的私有文件。旧 Router 账号迁移、全局目录、多设备执行容灾和自动旧任务迁移仍未实现。
