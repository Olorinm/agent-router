# Agent Router

**English** | [简体中文](README.zh-CN.md)

Agent Router is a communication service for agents: it receives messages across channels, delivers them to a running agent, and sends replies back to the same channel.

Ask your cloud agent to do something in Feishu and receive its reply there. Switch to an explicitly linked Weixin private chat to continue the same personal conversation. Other agents can also send tasks, check progress, and retrieve results.

## How it works

```text
Feishu / Weixin / Telegram / Email / Matrix / Other agents
                           ↕
                Agent Router (communication)
                           ↕
                Agent Host / worker (execution)
                           ↕
                  Models, tools, and workspace
```

Router manages agent identities, channel connections, communication sessions, task delivery, and replies. Agent Host or an existing worker runs models and tools in its own environment and retains the model's native session. The execution environment can be in the cloud or on a personal computer.

- **Stable identities**: one account can manage multiple agents. Each agent has its own address and can connect to multiple runtime instances.
- **Continuous conversations**: explicitly linked owner private chats share a main session. Group chats and other contacts have separate sessions; each reply returns to the channel that received that turn.
- **Persistent records**: incoming messages, tasks, execution bindings, and delivery receipts are saved. Known state is restored after a restart; uncertain outcomes wait for reconciliation to avoid duplicate execution.

## Available integrations

| Entry point | Current capabilities |
| --- | --- |
| Feishu | Text, media, replies, streaming cards and interaction buttons through the official Channel; QR setup for the app and personal authorization for official CLI tools |
| Weixin (WeChat) | Tencent iLink QR login, private text/media messages, voice transcripts and replies |
| Telegram | grammY Bot API: text/media, drafts, buttons and replies in private chats and group topics |
| Email | Incoming messages and replies through [Grove Mail](docs/guides/personal-channels.md) / [AgentMail](docs/guides/channels.md) |
| Matrix | Text/HTML, media, replies and streaming edits; A2A tasks and results exchanged between agents over Matrix |
| Products / other agents | Account, agent, and task APIs through the CLI or [TypeScript SDK](packages/sdk/README.md) |

Channels preserve their native communication capabilities through the Host: attachments, replies, supported streaming and interaction controls. Voice/video understanding depends on the chosen runtime and its tools. Weixin supports iLink private chats only; encrypted Matrix rooms are unsupported. Execution connects directly to a configured instance; intelligent scheduling and automatic failover are not implemented.

## Getting started

**This README describes the `main` source branch. Managed agents and personal channel integrations are not included in the published v0.6.0 release. Build from source and deploy a matching service version to use them.** See the [installation guide](docs/guides/install.md) for published releases.

Build from the repository root with Node.js 24+ and Go 1.25+. Go selects its toolchain from `go.mod`:

```sh
npm ci
npm run build
sh scripts/build-cli.sh
```

1. **Prepare a node and agent**: use an existing Router node, sign in, and create an agent to obtain its `agentId`. See the [account and agent guide](docs/guides/managed-agents.md), which also covers running your own node.
2. **Connect an execution environment**: configure the Agent Host service URL and `runtimeId`, or have an existing worker claim tasks. See [direct Host setup](docs/guides/personal-channels.md#最小启动) and the [Codex worker](examples/codex-worker/README.md).
3. **Link channels and start the service**: choose connections and bind the owner's channel addresses in a private `channels.json`. Follow the [personal channel guide](docs/guides/personal-channels.md); a complete configuration example is in [channels.example.json](examples/personal-agent/channels.example.json).

For Feishu, start with QR setup to configure the app and authorize your personal account:

```sh
npm run feishu:setup -- /absolute/private/path/feishu
```

Check the configuration, then send a message from the actual channel to verify a complete round trip:

```sh
npm run channels:check -- /absolute/private/path/channels.json
```

## More documentation

Most detailed guides are currently in Chinese; the agent CLI guide is available in both languages.

| What you want to do | Start here |
| --- | --- |
| Chat with a personal agent through IM or email | [Personal channel integrations](docs/guides/personal-channels.md) |
| Create agents, connect runtime instances, and collaborate with other agents | [Managed agents](docs/guides/managed-agents.md) |
| Have an existing agent claim tasks, reply, and handle cancellation | [Agent CLI guide](docs/guides/agent-connect.en.md) · [简体中文](docs/guides/agent-connect.md) |
| Add communication capabilities to your own product | [TypeScript SDK](packages/sdk/README.md) · [Existing product accounts](docs/guides/product-integration.md) |
| Understand module boundaries, sessions, and recovery | [Communication architecture](docs/architecture/communication-layer.md) · [CLI contract](docs/guides/cli-contract.md) |
| Deploy an independent domain with Matrix federation | [Node deployment](docs/guides/matrix.md#部署独立域) |

## Development and verification

```sh
go test -race ./...
npm run typecheck
npm test
npm run test:codex-worker
npm run build
```

Automated checks cover session isolation, deduplication, recovery, authorization, and the public Host interface. Live account round trips for the new chat connections still need integration testing. See the [verified scope](docs/guides/personal-channels.md#已验证范围) and [local verification guide](docs/guides/local-verification.md).

License: [Apache-2.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for reused components and their licenses.
