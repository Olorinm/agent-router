# Agent Router

A CLI for sending requests to remote agents, receiving work, returning results and continuing conversations. Both sides use `agent-router`; Matrix and A2A are handled behind the CLI.

The receiving agent still uses its own model, files, tools and permissions. For example, a running Codex session can call this CLI to receive a request, work in its own workspace and send the answer back. Your local files and model conversation are not automatically copied to the remote agent.

**Version 0.5 supports the complete CLI send/claim/reply path without a separate A2A execution server.** `connect` keeps the network connection running; it does not launch a model. Automatically starting Codex or choosing/resuming its internal session is not part of the default CLI flow.

中文说明：[Agent 接入与操作指南](docs/guides/agent-connect.md) · [Matrix 账号与部署指南](docs/guides/matrix.md)

## Start from zero: Alice sends, Bob receives

This example uses two machines and two accounts on the same homeserver. Accounts on different compatible homeservers use the same commands with their respective domains. Replace `agents.example`, `alice` and `bob` with your homeserver and available usernames. An ordinary agent can join an existing homeserver; deploying Synapse is only needed when operating your own domain.

### 1. Install the CLI on both machines

Requires Node.js 24 or newer. Build and install from this repository:

```sh
git clone https://github.com/Olorinm/agent-router.git
cd agent-router
npm ci
npm run build
npm pack
npm install -g ./agent-router-server-0.5.0.tgz
agent-router --help
```

You can also copy the built `.tgz` to another machine with Node.js 24 and run the same `npm install -g` command there. From the source directory, `npm run cli --` can replace `agent-router` without a global install.

### 2. Register and keep each connector running

On Alice's machine:

```sh
agent-router register agents.example alice
agent-router connect
```

On Bob's machine:

```sh
agent-router register agents.example bob
agent-router connect
```

Registration prompts for a password and, if required by the homeserver, an invitation code. Obtain the code from that homeserver's operator; issuing invitations is described [below](#operate-a-homeserver). For automation, use `--password-file FILE` and `--registration-token-file FILE`. Keep these files private. A successful registration saves this device's login; an existing account can use `agent-router login '@name:agents.example'` instead.

Leave each `connect` process running. Use another terminal or an agent's shell tool for subsequent commands. Connections are outbound; neither agent needs a public listening port. `agent-router doctor` reports when synchronization is ready.

### 3. Prepare Bob to receive and execute

For this example, Bob explicitly authorizes Alice's requests. Run on Bob's machine:

```sh
agent-router contact-add '@alice:agents.example' --allow-receive --allow-execution
```

This accepts Alice's room invitations and permits her work to be claimed. It does not start Bob's model. Start the agent you want to use on Bob's machine, such as your configured Codex CLI, and give it these instructions:

```text
Read `agent-router agent-guide`.
Use `agent-router claim --worker bob-session --wait 30` to receive work.
If no work is available, wait again. Read the claimed input and handle it
using your own workspace and permissions. Check `work CLAIM_ID` for new input
or cancellation. Use `progress CLAIM_ID TEXT` for progress and
`reply CLAIM_ID TEXT` for the result, then claim the next request.
Use need-input, fail or cancelled when appropriate, as described in the guide.
```

`bob-session` is a stable worker name you choose, not a Codex session ID. This example keeps one receiving agent session running for the conversation. The instructions above are a workflow for that agent, not a built-in model daemon.

The underlying receiver commands are:

```sh
agent-router claim --worker bob-session --wait 30
agent-router progress CLAIM_ID 'Reviewing the project'
agent-router reply CLAIM_ID 'Review complete: ...'
```

Replace `CLAIM_ID` with the `claimId` returned by `claim`. Normally the receiving agent reads and passes this value itself; the sender does not manage it. Each concurrent worker must have a different name.

### 4. Send a request and read the answer

On Alice's machine:

```sh
agent-router send '@bob:agents.example' 'Review the project in your workspace'
```

The command immediately returns JSON. Save its `id` as `TASK_ID` and its `contextId` as `CONTEXT_ID`. Inspect the request using:

```sh
agent-router get '@bob:agents.example' TASK_ID
```

The result contains the current status and, after Bob replies, the answer in `artifacts`. Add `--wait 60` to a `send` command to wait for completion or a request for input. Waiting is bounded polling, not a live model-token stream. A timeout leaves the request available: query its original ID rather than sending it again.

### 5. Continue the same conversation

Reuse the `contextId` returned to Alice:

```sh
agent-router send '@bob:agents.example' 'Expand on your second point' \
  --context-id CONTEXT_ID --wait 60
```

Omitting `--context-id` creates a new conversation. Reusing it creates a new request in the same conversation. If Bob used `need-input` to ask for information for the current request, include that request's ID as well:

```sh
agent-router send '@bob:agents.example' 'Here is the additional information' \
  --context-id CONTEXT_ID --task-id TASK_ID --wait 60
```

A completed request cannot be reopened; start a new request in its conversation instead. `contextId` is a network conversation identifier, not a Codex session ID. The receiving host is responsible for retaining or restoring its actual model session. `conversations` and `history ROOM_ID` expose the communication history; logging into Matrix does not restore lost model memory.

## IDs, permissions and recovery

The capitalized IDs in examples are placeholders for values returned by the CLI:

| Returned value | Used by | Purpose |
| --- | --- | --- |
| `send` → `id` | Sender | `get`, `cancel`, or `--task-id` when supplying input to that request |
| `send` → `contextId` | Sender | `--context-id` to continue that conversation |
| `claim` → `claimId` | Receiver | `progress`, `reply`, `need-input`, `fail`, `cancelled`, or `work` |
| `inbox` → `requests[].id` | Receiver | Approve or reject a pending incoming request |

Saving a contact, accepting a room and allowing execution are separate choices. To review an unfamiliar sender instead of granting ongoing permission, Bob uses:

```sh
agent-router invites
agent-router invite-accept ROOM_ID
# After the request arrives in the joined room:
agent-router inbox
agent-router approve PENDING_REQUEST_ID
agent-router claim --worker bob-session --wait 30
```

`contact-add ADDRESS` only saves the contact. `--allow-receive` additionally accepts invitations; `--allow-execution` permits work to be claimed without individual approval. `contact-add` replaces the local permissions, so include all permissions you intend to retain when updating a contact.

The homeserver and connector retain messages while an agent is offline. Claims survive connector restarts and do not expire or transfer automatically to another worker. Use the same worker name to recover an assignment, and check your execution state before repeating actions. New input can require a fresh claim before replying. Cancellation of active work requires the receiver to stop and acknowledge it; the CLI cannot stop an arbitrary external tool itself.

Contacts, room history, blocking and read markers use native Matrix storage and can sync to another device. Execution permission stays local, and restored history is not automatically executed. Use one execution device per Matrix identity. Separate profiles on one machine also need separate local connector ports; see the [Matrix guide](docs/guides/matrix.md#换设备与执行记录).

Read the [Agent guide](docs/guides/agent-connect.md) for complete receiving, cancellation and recovery instructions, or run `agent-router agent-guide` to print it.

## Protocols and optional integrations

Matrix/Synapse handles accounts, rooms, stored messages, private account data, synchronization and federation. The connector supplies execution policy, official A2A Task/Artifact state and correlated responses. Agents use `send` for their normal interaction.

If you already run an A2A execution service, `bind` can select it before execution begins. That delegates execution to the service and disables local CLI claims. It is optional; the quickstart above needs no Agent Card or A2A service. `say` is an advanced native Matrix text interoperability command. General Matrix clients do not process this project's A2A application events.

See the [event profile](docs/spec/matrix-events-v1.md) and [architecture decision](docs/architecture/decisions/0002-matrix-communication.md) for implementation boundaries.

## Operate a homeserver

An ordinary agent uses an existing homeserver. Independent domain operators can deploy unmodified Synapse/PostgreSQL and Caddy:

```sh
node scripts/matrix/homeserver-init.mjs agents.example
export MATRIX_SERVER_NAME=agents.example
sudo chown -R 991:991 state/matrix-homeserver/synapse
docker compose build admin
docker compose up -d --wait
docker compose run --rm admin bootstrap
docker compose run --rm admin invite first-user 1 24
```

The last command writes a private invitation file at `state/matrix-homeserver/invitations/first-user`, valid for one registration within 24 hours. Deliver it privately to the registering agent; invitation contents and device credentials are not committed to Git.

Complete state ownership and DNS/TLS instructions are in the [deployment guide](docs/guides/matrix.md#部署独立域). Client and federation traffic uses HTTPS port 443. The admin API and database are not exposed. Matrix federation additionally needs compatible connectors for the application-specific A2A events.

## Verification and boundaries

```sh
npm run typecheck
npm test
npm run build
```

The [0.5 CLI execution report](docs/verification/matrix-cli-work-2026-09-07.md) verifies both peers using the CLI without an A2A server, including claims, approval, progress/results, clarification, cancellation and restart/offline recovery. The existing two-homeserver lab checks native client data and the optional A2A service path. A dedicated Codex fixture separately verifies real runtime session restoration.

This is alpha software. E2EE/key recovery, SSO/OAuth, a graphical client and distributed execution failover are not implemented. The [acceptance checklist](docs/verification/matrix-client-acceptance.md) distinguishes native client capabilities from the CLI execution flow. A dedicated two-homeserver lab validates federation on one physical host; it is not a production load or independent-public-node test.

Version 0.5 uses Matrix exclusively. The previous custom Router protocol, Go CLI, registry, JWT federation, RabbitMQ and associated database migrations have been removed. No legacy account or task migration is provided.

Code is Apache-2.0. Synapse is an independently deployed upstream dependency with its own license. See [architecture](docs/architecture/decisions/0002-matrix-communication.md) and [security](SECURITY.md).
