# Tools in the execution environment

**English** | [简体中文](worker-tools.zh-CN.md)

Install tools in the environment image used by Agent Host. The native agent calls
CLIs through its terminal and MCP servers through its own MCP support. Router
handles messages, channel credentials and replies.

## Prepare the environment

Follow [cloud onboarding](cloud-environments.md) to publish an environment
profile. Install the required CLIs in its image and pin their versions. For
Feishu, use the official `@larksuite/cli`; read its bundled instructions with
`lark-cli skills read lark-shared`.

Set `LARKSUITE_CLI_CONFIG_DIR` and `LARKSUITE_CLI_DATA_DIR` in the Host runtime's
`env`, pointing to private persistent directories. Keep both directories: the
data directory can contain token encryption material. Supply credentials through
private profile files, never through source code, image layers or chat messages.

Operators can run tools inside an existing environment:

```sh
agent-environment exec --config /private/providers.json --provider cloud \
  --id ENVIRONMENT_ID -- lark-cli --version
```

Administrative commands must use the same config/data environment variables as
the Host runtime. `agent-environment exec` does not inherit runtime configuration.
It is an operator CLI; product users use `agent-router setup` and channel commands.

## Connect and verify Feishu

Inside the environment, initialize the application using `lark-cli config init`
and supply the secret through `--app-secret-stdin` from a private file. Reuse the
channel application when appropriate. Then run:

```sh
lark-cli config default-as bot
lark-cli auth status --json --verify
lark-cli im +chat-messages-list --as bot --chat-id '<chat-id>' --page-size 5
```

Shared group agents should use bot identity. Personal account authorization is
appropriate for a private execution environment: use
`lark-cli auth login --domain im --no-wait --json`, complete its official consent
flow, then finish with `lark-cli auth login --device-code '<device-code>'`.
Authorization on a laptop or Router does not automatically authorize the CLI
inside the environment. Choose the required domains and preserve the identity
throughout each workflow.

Success requires exit code zero and `ok: true`. Bot group-history access requires
`im:message.group_msg` and a message-reading scope; @mention access alone is
insufficient. See the [official API prerequisites](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list).

Channel tasks include provider conversation, message, sender and quoted-message
IDs. For Feishu, the conversation ID is `--chat-id`. Use these IDs to retrieve
relevant history; ordinary replies still return through Router. Follow the CLI's
official confirmation requirements and never change identity to bypass a failure.

Pause and resume the environment, then repeat verification to check persistence.
Different users need separate credential stores. Update tools by publishing a
new image and migrating environments with their persistent data.
