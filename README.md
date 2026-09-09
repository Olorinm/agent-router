# Agent Router

A CLI for sending requests to remote agents, receiving work, returning results and continuing conversations. Both sides use `agent-router`; Matrix and A2A are handled behind the CLI.

The receiving agent still uses its own model, files, tools and permissions. For example, a running Codex session can call this CLI to receive a request, work in its own workspace and send the answer back. Your local files and model conversation are not automatically copied to the remote agent.

**Current source separates owner accounts, Agents and runtime instances.** Register one Matrix account, create several Agents under it, and connect each runtime with a scoped credential. Matrix identities are provisioned automatically in the server. A runtime needs only the standalone Go CLI; the node runs the Matrix/A2A service.

These managed-Agent commands are **not in the published v0.6.0 release**. Build the current source and deploy its matching service. The [v0.6 installation guide](docs/guides/install.md) documents the existing release; it does not install the new commands yet.

[Managed account/Agent guide (中文)](docs/guides/managed-agents.md) · [Agent guide](docs/guides/agent-connect.en.md) · [CLI contract](docs/guides/cli-contract.md) · [Architecture](docs/architecture/decisions/0004-managed-agents.md)

## Start from zero: one account, two Agents

Use a node running this project's Agent service and Matrix homeserver. `agents.example` is a placeholder; obtain an account or registration invitation from its operator. Deploying a node is needed only when operating your own domain.

### 1. Build the standalone CLI and log in once

```sh
sh scripts/build-cli.sh
./bin/agent-router --profile owner login '@alice:agents.example'
# Without an account: ./bin/agent-router --profile owner register agents.example alice
```

Password input is hidden. Registration may require an invitation. Automation can use private `--password-file FILE` and `--registration-token-file FILE` inputs. The Go binary needs no Go or Node runtime after it is built.

### 2. Create your Agents

```sh
./bin/agent-router --profile owner agent-create laptop
./bin/agent-router --profile owner agent-create coder
./bin/agent-router --profile owner agents
```

Each creation selects that Agent. Their addresses are `alice/laptop@agents.example` and `alice/coder@agents.example`. Each has a separate managed Matrix identity; no additional password or human registration is involved. Use `agent-use NAME` to switch, and `agent-current` to see the current selection.

### 3. Connect a receiving runtime

On the owner machine:

```sh
./bin/agent-router --profile owner agent-use coder
./bin/agent-router --profile owner agent-instance-create server --out server-instance.json
```

Transfer the private file to the runtime machine and preserve its 0600 permissions. With the built CLI installed there:

```sh
agent-router --profile worker agent-attach server-instance.json
agent-router --profile worker connect
```

In managed mode `connect` checks the node and exits. No local Matrix connector or Matrix account credentials are needed. Start your agent harness and have it read `agent-router agent-guide`; it uses `claim`, handles the work in its own environment, and calls `reply`:

```sh
agent-router --profile worker claim --worker codex --wait 30
agent-router --profile worker progress CLAIM_ID 'Reviewing the project'
agent-router --profile worker reply CLAIM_ID 'Review complete: ...'
```

`CLAIM_ID` is returned by `claim` and normally handled by the Agent itself. The service binds work to the authenticated instance, not to the name supplied in `--worker`. For automatically starting/resuming Codex, use the [supervised worker](examples/codex-worker/README.md) and its managed Compose configuration.

### 4. Authorize and send

On the owner machine, allow laptop's work at coder, then send as laptop:

```sh
./bin/agent-router --profile owner agent-use coder
./bin/agent-router --profile owner contact-add 'alice/laptop@agents.example' --allow-receive --allow-execution
./bin/agent-router --profile owner agent-use laptop
./bin/agent-router --profile owner send 'alice/coder@agents.example' 'Review the project in your workspace' --wait 180
```

`send` returns a task with `id` and `contextId`; the completed answer is in `artifacts`. If a wait expires, query the existing task with `get ADDRESS TASK_ID`. It does not cancel execution. For reliable scripts, send without waiting, save the returned IDs, then poll `get`.

Continue the conversation with `send ADDRESS TEXT --context-id CONTEXT_ID`. Include `--task-id TASK_ID` only when providing additional input to a nonterminal task. A network context does not itself restore model memory: the receiving harness must retain its actual model session and files.

### 5. Add or revoke instances

```sh
./bin/agent-router --profile owner agent-use coder
./bin/agent-router --profile owner agent-instance-create desktop --out desktop-instance.json
./bin/agent-router --profile owner agent-instances
./bin/agent-router --profile owner agent-instance-revoke INSTANCE_ID
```

Different conversations can be handled by different instances. Each conversation stays pinned to its first instance, and one instance holds at most one active claim. Use a distinct credential for every concurrently running instance. Reissuing the same instance name rotates its token while preserving its identity. Automatic context migration and crash takeover are not implemented.

## IDs, permissions and recovery

The capitalized IDs in examples are placeholders for values returned by the CLI:

| Returned value | Used by | Purpose |
| --- | --- | --- |
| `send` → `id` | Sender | `get`, `cancel`, or `--task-id` when supplying input to that request |
| `send` → `contextId` | Sender | `--context-id` to continue that conversation |
| `claim` → `claimId` | Receiver | `progress`, `reply`, `need-input`, `fail`, `cancelled`, or `work` |
| `inbox` → `requests[].id` | Receiver | Approve or reject a pending incoming request |

Saving a contact, accepting a room and allowing execution are separate choices. The owner can review an unfamiliar sender on the selected Agent:

```sh
agent-router invites
agent-router invite-accept ROOM_ID
# After the request arrives in the joined room:
agent-router inbox
agent-router approve PENDING_REQUEST_ID
agent-router claim --worker bob-session --wait 30
```

`contact-add ADDRESS` only saves the contact. `--allow-receive` additionally accepts invitations; `--allow-execution` permits work to be claimed without individual approval. `contact-add` replaces the local permissions, so include all permissions you intend to retain when updating a contact.

The homeserver and connector retain messages while an agent is offline. Claims survive connector restarts and do not expire or transfer automatically to another worker. Use the same instance identity (or worker name in native connector mode) to recover an assignment, and check your execution state before repeating actions. New input can require a fresh claim before replying. Cancellation of active work requires the receiver to stop and acknowledge it; the CLI cannot stop an arbitrary external tool itself.

Contacts, room history, blocking and read markers use native Matrix storage and can sync to another device. Execution permission stays in the Agent gateway, and restored history is not automatically executed. Managed runtime instances share that gateway; they do not start independent connectors for the same identity. Separate profiles on one machine also need separate local connector ports; see the [Matrix guide](docs/guides/matrix.md#换设备与执行记录).

Read the [English Agent guide](docs/guides/agent-connect.en.md) or [中文指南](docs/guides/agent-connect.md) for complete receiving, cancellation and recovery instructions. `agent-router agent-guide` prints the guide bundled with your installed version. Current source builds default to English and also accept `agent-guide en` or `agent-guide zh`; the published v0.6.0 binary retains its original Chinese guide until upgraded.

Stop `connect` with Ctrl-C or SIGTERM. Restart with the same profile and worker name to recover local work. Stop the connector before `agent-router logout`; logout revokes the device token but keeps local execution records and does not cancel remote tasks.

## Protocols and optional integrations

Matrix/Synapse handles accounts, rooms, stored messages, private account data, synchronization and federation. The connector supplies execution policy, official A2A Task/Artifact state and correlated responses. Agents use `send` for their normal interaction.

If you already run an A2A execution service, `bind` can select it before execution begins. That delegates execution to the service and disables local CLI claims. It is optional; the quickstart above needs no Agent Card or A2A service. `say` is an advanced native Matrix text interoperability command. General Matrix clients do not process this project's A2A application events.

See the [event profile](docs/spec/matrix-events-v1.md) and [architecture decision](docs/architecture/decisions/0002-matrix-communication.md) for implementation boundaries.

## Operate a homeserver

An ordinary agent uses an existing homeserver. Independent domain operators deploy Synapse/PostgreSQL/Caddy and the Agent service registered as a Matrix Application Service:

```sh
node scripts/matrix/homeserver-init.mjs agents.example
export MATRIX_SERVER_NAME=agents.example
sudo chown -R 991:991 state/matrix-homeserver/synapse
sudo chown -R 1000:1000 state/agent-service state/agent-service-secrets
docker compose build admin agent-service
docker compose up -d --wait
docker compose run --rm admin bootstrap
docker compose run --rm admin invite first-user 1 24
```

The last command writes a private invitation file at `state/matrix-homeserver/invitations/first-user`, valid for one registration within 24 hours. Deliver it privately to the registering agent; invitation contents and device credentials are not committed to Git.

For existing nodes, run `scripts/matrix/agent-service-init.mjs` before enabling the new service; see the [managed deployment guide](docs/guides/managed-agents.md#部署节点). Complete state ownership and DNS/TLS instructions are in the [deployment guide](docs/guides/matrix.md#部署独立域). Client and federation traffic uses HTTPS port 443. The admin API and database are not exposed. Matrix federation additionally needs compatible connectors for the application-specific A2A events.

## Verification and boundaries

```sh
go test -race ./...
sh scripts/build-cli.sh
npm run typecheck
npm test
npm run build
```

The [0.6 Go CLI report](docs/verification/go-cli-2026-09-07.md) records standalone binary, cross-language gateway, real account and federation checks. The [0.5 CLI execution report](docs/verification/matrix-cli-work-2026-09-07.md) verifies both peers using the CLI without an A2A server, including claims, approval, progress/results, clarification, cancellation and restart/offline recovery. The existing two-homeserver lab checks native client data and the optional A2A service path. A dedicated Codex fixture separately verifies real runtime session restoration.

This is alpha software. E2EE/key recovery, SSO/OAuth, a graphical client and distributed execution failover are not implemented. The [acceptance checklist](docs/verification/matrix-client-acceptance.md) distinguishes native client capabilities from the CLI execution flow. The managed-Agent verification also exercises Application Service virtual identities across two homeservers. The two-homeserver lab runs on one physical host; it is not a production load or independent-public-node test.

Version 0.6 uses Matrix exclusively. The current Go CLI uses the existing Matrix/A2A gateway and account profiles. The previous custom Router protocol, its old Go implementation, registry, JWT federation, RabbitMQ and associated database migrations remain retired. No legacy Router account or task migration is provided. See the [Go CLI architecture decision](docs/architecture/decisions/0003-go-cli.md) for component and distribution boundaries.

Code is Apache-2.0. Synapse is an independently deployed upstream dependency with its own license. See [architecture](docs/architecture/decisions/0002-matrix-communication.md) and [security](SECURITY.md).

## Embed in another product

Use the standalone [TypeScript SDK](packages/sdk/README.md) for direct HTTP integration without the CLI. Optional [product account integration](docs/guides/product-integration.md) reuses a configured existing user-info API and can restrict enrollment to a role such as admin.
