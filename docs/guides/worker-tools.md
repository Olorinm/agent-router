# Tools in the execution environment

**English** | [简体中文](worker-tools.zh-CN.md)

Install a CLI where the agent runs and let its native terminal tool call it.
Router receives messages and sends replies; the execution environment holds the
tool installation, account configuration, and persistent files.

The [Codex worker example](../../examples/codex-worker/README.md) includes the
official `@larksuite/cli` 1.0.97. Its skills are embedded in the binary and read
with `lark-cli skills read`; they stay aligned with the installed version.

## Connect an account

Run these commands from `examples/codex-worker` after preparing the managed worker
deployment. Build the updated full image and retain its existing state volumes:

```sh
docker compose -f compose.managed.yaml up -d --build
docker compose -f compose.managed.yaml exec worker lark-cli --version
docker compose -f compose.managed.yaml exec worker lark-cli skills read lark-shared
```

Compose sets `WORKER_LARK_DIR=/state/lark` and the official CLI configuration/data
environment variables. Both directories live on the persistent worker volume.
For a standalone worker, set `WORKER_LARK_DIR` to an absolute persistent directory;
when running administrative CLI commands, also set `LARKSUITE_CLI_CONFIG_DIR` to
`<directory>/config` and `LARKSUITE_CLI_DATA_DIR` to `<directory>/data`.

Reuse the channel's existing application when appropriate. Supply its secret
through stdin from an operator-managed private file; never put it in the image,
command arguments, source control, or conversation:

```sh
docker compose -f compose.managed.yaml exec -T worker \
  lark-cli config init --app-id '<app-id>' --app-secret-stdin --brand feishu \
  < secrets/feishu-app-secret
docker compose -f compose.managed.yaml exec worker lark-cli config default-as bot
docker compose -f compose.managed.yaml exec worker lark-cli auth status --json --verify
```

Bot identity uses the application's own access and needs no personal login. Use
`--as bot` explicitly for its operations. A worker receiving shared group requests
should use a bot account, not a group member's private account.

For a **private user execution environment**, set up the same application and
complete official user authorization there:

```sh
docker compose -f compose.managed.yaml exec worker \
  lark-cli auth login --domain im --no-wait --json
# Open the returned verification_url (an agent should also generate its QR code).
# After completing consent, finish the same flow with the returned device_code:
docker compose -f compose.managed.yaml exec worker \
  lark-cli auth login --device-code '<device-code>'
docker compose -f compose.managed.yaml exec worker lark-cli config default-as user
docker compose -f compose.managed.yaml exec worker lark-cli auth status --json --verify
```

Choose the domains actually needed, such as `im`, `docs`, or `calendar`. Personal
authorization on your laptop or Router does not automatically authorize this
worker. Keep the entire configuration **and data** directories across restarts;
the data directory may contain token encryption material as well as tokens.

## Verify actual use

```sh
docker compose -f compose.managed.yaml exec worker \
  lark-cli im +chat-messages-list --as bot --chat-id '<chat-id>' --page-size 5
```

Success means exit code zero and `ok: true`. A missing bot scope needs an app
permission change; a missing user scope needs user consent. Do not change identity
just to bypass a failed request. The worker tells the model to read the CLI's
bundled skills and preserve its confirmation requirements.

Channel tasks include the provider conversation, message, sender, and quoted
message IDs. For Feishu, the provider conversation ID is the CLI's `--chat-id`.
The agent can fetch recent messages or follow a thread when prior discussion is
needed. This supplies retrieval tools; it does not automatically preload all
history or change session grouping. Ordinary replies still go through Router.

Restart the worker and repeat the read to verify persistence. Multiple agents
belonging to one user may use the same tool image and execution environment;
different users need their own configuration/data volumes. This example does not
provision per-user VMs or implement a multi-user environment manager.

## Upgrade an existing customized worker

Use `Dockerfile.tools` with `--build-arg WORKER_IMAGE=<existing-image>` to install
the CLI without replacing existing worker integrations. Incorporate the example's
`WORKER_LARK_DIR` environment forwarding and skill guidance into that worker.
Back up the Compose file and persistent state, deploy a new image tag, and retain
the previous image for rollback. Do not run an in-container global update on a
read-only root filesystem; rebuild the image to update tools reproducibly.
