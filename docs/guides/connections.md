# Connect channels to an Agent

[简体中文](connections.zh-CN.md)

Router owns accounts, Agent identities, connections and task delivery. Cloud Agent
creation and environment lifecycle belong to [Mau](https://github.com/Olorinm/mau).
Build current source; these connection commands are not in the old v0.6.0 release.

```sh
agent-router login '@alice:agents.example'
agent-router agent-create helper
agent-router connection-options
```

An operator or embedding product connects a Host; an existing worker may also
claim tasks using Router's normal instance API.

## Connect your chosen platforms

```sh
agent-router channel-connect feishu
agent-router channel-connect weixin
agent-router channel-connect telegram --bot-token-file /private/telegram-token
agent-router channel-connect matrix
```

Run only the commands for the platforms you want.

- **Feishu:** the terminal displays the official app setup QR/link. App consent
  connects messaging; personal tools request personal consent separately when
  needed (or through `channel-auth`). Use `--domain lark` for Lark, or
  `--messaging-only` to omit personal tools. Personal tools require a direct Host.
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

Feishu app consent uses the expiry reported by the official SDK (`expireIn`),
including its fallback. Router no longer adds a separate ten-minute consent limit.
Other setup jobs have a ten-minute deadline. Recent job history, credentials and channel
configuration survive Router restarts. An interrupted consent poll is reported as
failed with recovery instructions; the SDK does not expose a durable app-registration
resume token. `channel-job` resumes observation of a running poll, not a lost poll.

If the app was created but setup expired before credentials were saved, select its
App ID from the developer console and authorize that same app through the official
page. No App Secret needs to be copied:

```sh
agent-router channel-connect feishu --app-id cli_YOUR_EXISTING_APP_ID
```

Use the original `--domain` and `--messaging-only` choices when retrying. A saved
credential is reused after a binding failure. An uncertain creation result blocks
creating another app until an existing App ID is supplied; never delete the pending
marker merely to retry. Apps already assigned to another Agent are rejected.
Connecting an already configured platform does not silently replace it.
The API accepts optional `appId` on the Feishu connection request. Failed jobs
include a `recovery` object (`action`, optional `appId`, `domain`, `personalTools`).

For Feishu personal authorization:

```sh
agent-router channel-auth feishu status
agent-router channel-auth feishu begin
# After consenting to the printed link:
agent-router channel-auth feishu complete
```

## Check and chat

```sh
agent-router channels
agent-router connection-check
```

Checks verify configuration, access and connection startup. They do not consume
new messages, send a test message or run a model. An empty connections list is
reported explicitly. Feishu bot access and personal authorization have separate
check entries; missing personal consent does not fail the bot check. Send a real message in your
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

To share your Agent, your friend logs in and runs `agent-create client` without a Host.
You select your executing Agent and grant their public address:

```sh
agent-router agent-use helper
agent-router contact-add bob/client@agents.example --allow-receive --allow-execution
```

Your friend can then `send alice/helper@agents.example 'Hello' --wait 60`.
They can use the Agent you authorized; they cannot manage your Host, connections
or account. `requests`, `approve` and `reject` retain the existing per-request
approval flow when automatic execution has not been granted.

## Operator configuration

Deploy the [Router node](managed-agents.md#部署节点). Optional
`AGENT_ROUTER_CONNECTIONS_FILE` points to a private JSON object containing
`mailServices` (id, label, URL and attachmentOrigins); omit it for other channels.
No cloud credentials or environment profiles are loaded by Router.

Persist the entire Router state, including `connections/agents/`. Channel edits
are atomic and stop the previous consumer before replacement. Active or uncertain
work blocks a change. Configuration views omit secrets; runtime credentials cannot
manage owner connections. [Embedding products](../architecture/embedding.md) may
provide a Host through the public package API.

HTTP routes are under `/_agent-router/v1`: `GET /connection-options`,
`GET /agents/:id/configuration`, `POST /agents/:id/connections`,
`GET /agents/:id/connection-jobs`, `GET /agents/:id/connection-jobs/:job`,
`POST /agents/:id/connection-jobs/:job/pairing`, and `POST /agents/:id/check`.
The former `/setup` and environment routes are removed.
