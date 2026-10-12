# Agent Router

[English](README.md) | **简体中文**

Agent Router 是 Agent 的通信服务：接收各渠道的消息，交给运行中的 Agent，再把回复送回原渠道。

你可以在飞书里让云端 Agent 办事，收到飞书回复；换到明确绑定的微信私聊，继续同一私人会话。其他 Agent 也可以向它发送任务、查询进度和取回结果。

## 工作方式

```text
飞书 / 微信 / Telegram / 邮件 / Matrix / 其他 Agent
                         ↕
                 Agent Router（通信）
                         ↕
              Agent Host / worker（执行）
                         ↕
                 模型、工具与工作区
```

Router 管理 Agent 身份、渠道连接、通信会话、任务投递和回复。Agent Host 或现有 worker 在自己的环境中运行模型、调用工具，并保留原生模型会话；执行端可以位于云端或个人电脑。

- **稳定身份**：一个账号可以管理多个 Agent，每个 Agent 有自己的地址，并可连接多个运行实例。
- **连续对话**：明确绑定的所有者私聊共享主会话，群聊和其他联系人使用独立会话；每轮回复回到该轮的原渠道。
- **持久化记录**：保存收件、任务、执行绑定和发送回执；重启后恢复已知状态，结果未知时等待核对，避免重复执行。

## 已有接入

| 入口 | 当前能力 |
| --- | --- |
| 飞书 | 官方 Channel 收发文字和媒体、引用、流式卡片、交互按钮；扫码配置应用、个人授权后使用官方 CLI 工具 |
| 微信 | 腾讯 iLink 扫码登录、私聊文字/媒体、语音转写和引用 |
| Telegram | grammY Bot API：文字/媒体、草稿流、按钮和引用，支持私聊和群组话题 |
| 邮件 | [Grove Mail](docs/guides/personal-channels.md) / [AgentMail](docs/guides/channels.md) 的收信和回复 |
| Matrix | 文字/HTML、媒体、引用和流式编辑；Agent 之间通过 Matrix 交换 A2A 任务和结果 |
| 产品 / 其他 Agent | 使用 CLI 或 [TypeScript SDK](packages/sdk/README.md) 接入账号、Agent 和任务接口 |

各渠道的原生能力通过 Host 接通：附件、引用、支持的流式输出和交互控制。语音/视频理解取决于执行端模型及工具。微信限 iLink 私聊，Matrix 不支持加密房间。执行按配置直连固定实例，智能调度与自动故障转移尚未实现。

## 开始使用

**本页对应 `main` 源码。托管 Agent 和多渠道个人接入尚未包含在已发布的 v0.6.0 中；使用这些功能需要从源码构建，并部署匹配版本的服务。** 已发布版本的安装方式见[安装指南](docs/guides/install.md)。

**普通用户：**打开 `https://你的服务域名/_agent-router/setup`，登录，创建自己的 Agent 或使用朋友授权的 Agent，再按需选择连接的平台。见[网页开通指南](docs/guides/onboarding.zh-CN.md)；管理员先按该指南配置一次，用户之后就能从这个入口使用。

在仓库根目录构建，需 Node.js 24+ 和 Go 1.25+；Go 按 `go.mod` 选择工具链：

```sh
npm ci
npm run build
sh scripts/build-cli.sh
```

1. **准备节点和 Agent**：使用已有 Router 节点，登录账号并创建 Agent，取得 `agentId`。见[账号与 Agent 指南](docs/guides/managed-agents.md)。自行运行节点也按该指南部署。
2. **连接执行端**：配置 Agent Host 的服务地址与 `runtimeId`，或让现有 worker 领取任务。见[Host 直连接入](docs/guides/personal-channels.md#最小启动)与 [Codex worker](examples/codex-worker/README.md)。
3. **绑定渠道并启动**：在私有 `channels.json` 中选择连接、绑定所有者地址，按[多渠道接入指南](docs/guides/personal-channels.md)配置并启动服务。完整示例见 [channels.example.json](examples/personal-agent/channels.example.json)。

飞书可从扫码开始，完成应用配置与个人授权：

```sh
npm run feishu:setup -- /absolute/private/path/feishu
```

配置完成后检查连接，再从实际渠道发消息验证往返：

```sh
npm run channels:check -- /absolute/private/path/channels.json
```

## 更多文档

详细指南目前以中文为主，Agent 操作指南提供中英文版本。

| 你想做什么 | 从这里开始 |
| --- | --- |
| 通过 IM 或邮件与个人 Agent 对话 | [多渠道个人接入](docs/guides/personal-channels.md) |
| 创建 Agent、接入运行实例、让 Agent 互相协作 | [托管 Agent 指南](docs/guides/managed-agents.md) |
| 让现有 Agent 领取任务、回复和处理取消 | [Agent 操作指南](docs/guides/agent-connect.md) · [English](docs/guides/agent-connect.en.md) |
| 把通信能力接入自己的产品 | [TypeScript SDK](packages/sdk/README.md) · [已有产品账号接入](docs/guides/product-integration.md) |
| 了解模块边界、会话和恢复机制 | [通信层架构](docs/architecture/communication-layer.md) · [CLI 契约](docs/guides/cli-contract.md) |
| 部署独立域和 Matrix 联邦 | [节点部署](docs/guides/matrix.md#部署独立域) |

## 开发与验证

```sh
go test -race ./...
npm run typecheck
npm test
npm run test:codex-worker
npm run build
```

自动化验证覆盖会话隔离、去重、恢复、授权和 Host 公共接口；新增聊天连接的真实账号往返仍需联调。验证方法见[接入指南](docs/guides/personal-channels.md#已验证范围)和[本地验证指南](docs/guides/local-verification.md)。

许可证：[Apache-2.0](LICENSE)。复用组件及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
