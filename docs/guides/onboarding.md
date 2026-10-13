# Set up an Agent with the CLI

[简体中文](onboarding.zh-CN.md)

Use an existing Router service, sign in with your account, create an Agent,
choose its execution service, then connect whichever platforms you want.
Everything runs through the existing Go CLI. Build the current source;
the published v0.6.0 binary does not include these commands.

## Your first Agent

Your operator supplies the service domain and an account or registration invite.
The Router and Host run on the server. You only need the CLI on your computer.

```sh
agent-router login '@alice:agents.example'
# If registration is enabled instead:
# agent-router register agents.example alice --registration-token-file /private/invite

agent-router setup-options
agent-router setup helper --environment cloud-codex
```

Login reads your password with a hidden prompt. `setup-options` lists the environment
profiles assigned to your account. `setup helper --environment cloud-codex` creates
or selects your Agent, allocates its environment and starts Host automatically.
`setup` without a name inspects the selected Agent. Platforms are optional.
See [cloud setup](cloud-environments.md) for lifecycle commands and operator configuration.

## Connect your chosen platforms

```sh
agent-router channel-connect feishu
agent-router channel-connect weixin
agent-router channel-connect telegram --bot-token-file /private/telegram-token
agent-router channel-connect matrix
```

Run only the commands for the platforms you want. A single command can also do
initial setup: `agent-router setup helper --environment cloud-codex --channel feishu`.

- **Feishu:** the terminal displays the official app setup QR/link, then the
  personal authorization QR/link. Both must finish before personal tools are
  enabled. Use `--domain lark` for Lark, or `--messaging-only` to connect messages
  without personal tools. Personal tools require a direct Host.
- **Weixin:** scan the terminal QR in WeChat. If Tencent requires a pairing code,
  the CLI prompts without echo. This is Tencent iLink private chat support.
- **Telegram:** create a bot with BotFather and supply its token using a file
  or hidden prompt. Open the printed one-use link and press Start in a private
  chat. The Router binds that sender only after the matching `/start` proof.
  The bot must have no webhook or other polling consumer.
- **Matrix:** connect native chat using the Agent's existing service identity.
  The underlying Matrix identity/transport remains part of the node even when
  you do not choose Matrix as a user-facing platform.

Email setup uses an operator-configured Grove Mail service and an existing inbox:

```sh
agent-router channel-connect grove-mail \
  --mail-service mail --inbox helper@mail.example \
  --owner-email alice@example.org --api-key-file /private/mail-key
```

This does not authorize an arbitrary Gmail/Outlook mailbox. Legacy AgentMail
configuration remains available through the [channel guide](channels.md).
Secrets are read from files or hidden prompts, never command-line token values.

The CLI waits for QR setup by default, and prints the job ID immediately.
`--no-wait` returns JSON for automation. You can close the CLI and resume while
the Router remains running:

```sh
agent-router channel-jobs
agent-router channel-job JOB_ID
agent-router channel-pair JOB_ID --pairing-code-file /private/pairing-code
```

Jobs expire after ten minutes and are not persisted across Router restarts.
Connected credentials and configuration are persisted. Reconnecting an already
configured platform requires operator configuration; it does not replace it silently.
For Feishu personal authorization renewal:

```sh
agent-router channel-auth feishu status
agent-router channel-auth feishu begin
# After consenting to the printed link:
agent-router channel-auth feishu complete
```

## Check and chat

```sh
agent-router channels
agent-router setup-check
```

Checks verify configuration, access and connection startup. They do not consume
new messages, send a test message or run a model. Send a real message in your
chosen platform to verify a complete round trip.

The existing CLI `send/get` path also works without an IM connection. Select a
separate calling Agent because an Agent cannot send a task to itself:

```sh
agent-router agent-create client
# Grant this calling Agent access to helper:
agent-router agent-use helper
agent-router contact-add alice/client@agents.example --allow-receive --allow-execution
agent-router agent-use client
agent-router send alice/helper@agents.example 'Hello' --wait 60
```

Use the returned `contextId` in the next `send --context-id ID` to continue the
same conversation, and `get ADDRESS TASK_ID` to retrieve a pending result.
Personal Feishu tools are restricted to linked owner channel conversations;
A2A access alone does not confer access to the owner's personal account.

To share your Agent, your friend logs in and runs `setup client` without a Host.
You select your executing Agent and grant their public address:

```sh
agent-router agent-use helper
agent-router contact-add bob/client@agents.example --allow-receive --allow-execution
```

Your friend can then `send alice/helper@agents.example 'Hello' --wait 60`.
They can use the Agent you authorized; they cannot manage your Host, connections
or account. `requests`, `approve` and `reject` retain the existing per-request
approval flow when automatic execution has not been granted.

## Operator setup

Deploy the [Router node](managed-agents.md#部署节点) and configure a sandbox
provider, template, Host image and owner-assigned environment profiles as described
in [cloud setup](cloud-environments.md). Account registration remains on the account server.

```sh
npm ci
npm run build
sh scripts/build-cli.sh
npm run onboarding:init -- --out /private/router/onboarding.json \
  --environments-file /private/router/environments.json
```

Set `AGENT_ROUTER_ONBOARDING_FILE` to that private file and restart `agent:service`.
Mount the provider/profile files and sandbox key, and retain the writable service
state volume. Native credentials must belong to the profile's assigned users.
Users select a profile ID, never arbitrary server URLs or credential paths.
Channel updates stop the old consumer and save atomically, with rollback on failure.
Active or uncertain work blocks replacement. Existing execution history requires
an explicit migration before changing Host/runtime or tool definitions.
The former fixed-Host setup endpoint and Codex exec worker have been removed.

Back up the Router databases and `state/agent-service/onboarding/` together.
Per-Agent configuration and platform credentials are private files (0600) under
private directories (0700). Host and channel secrets are not returned in CLI
configuration views. Owner access uses the existing bearer token and ownership
checks; worker instance credentials cannot configure channels.

Local checks cover the Go CLI, protocol fixtures, account boundaries, private
persistence, rollback and an A2A → Host → reply round trip. Actual provider
accounts and model execution still need live integration testing.

Authenticated configuration requests are also limited to 600 per minute per account, in addition to the service limit before authentication.
