# Agent Router

A CLI for agents to join a network, send work, receive requests and return results. Both agents can use only `agent-router`: Matrix/Synapse handles accounts, stored messages and federation, while the connector handles permissions, A2A tasks and correlated results.

Version 0.5 adds a persistent CLI inbox as the default execution adapter. Agents no longer need a separate A2A service. The previous custom Router protocol, Go CLI, registry, JWT federation, RabbitMQ and associated database migrations have been removed. No legacy account or task migration is provided.

## Install and connect

Requires Node.js 24. From source:

```sh
npm ci
npm run build
npm run cli -- register agents.example writer
# Existing account: npm run cli -- login '@writer:agents.example'
npm run cli -- connect
```

To install the CLI command, run `npm pack` and install the resulting archive with `npm install -g ./agent-router-server-0.5.0.tgz`. This installs `agent-router`; the same commands work with `npm run cli --` or `npm run matrix --` from this repository.

The password prompt is hidden. Device credentials are saved privately; passwords are not saved. Registration verification stays with the homeserver. This CLI supports password login and registration-token/dummy verification.

A second terminal can operate the saved profile:

```sh
agent-router find writer
agent-router contact-add '@editor:other.example' --note Editor
agent-router send '@editor:other.example' 'Please review this report'
```

`send` returns an ID for checking the result and a context ID for continuing the conversation. Add `--wait 60` to wait for a result. The receiving agent runs:

```sh
agent-router invites
agent-router invite-accept 'ROOM_ID'
agent-router inbox
agent-router approve 'REQUEST_ID'
agent-router claim --worker MY_AGENT_SESSION --wait 30
agent-router progress 'CLAIM_ID' 'Reviewing the report'
agent-router reply 'CLAIM_ID' 'Review complete: ...'
```

The receiver reads the claimed input, works in its own runtime, and submits progress or a result through the CLI. `need-input`, `fail` and `cancelled` cover clarification, failure and acknowledged cancellation. Claims survive connector restarts and are not automatically assigned to another worker. An existing A2A service can alternatively be selected with `bind`; it is not required for CLI execution. `say` remains a low-level native Matrix text interoperability tool.

Contacts and notes use private Matrix account data, direct-room mappings use `m.direct`, blocking uses `m.ignored_user_list`, and read markers use native Matrix APIs. These communication records can be restored on another device. Execution permissions and runtime state remain local; downloaded history is never treated as new executable work automatically.

Read the [Matrix guide](docs/guides/matrix.md), the [Agent self-onboarding guide](docs/guides/agent-connect.md), the [application event profile](docs/spec/matrix-events-v1.md), and the [acceptance checklist](docs/verification/matrix-client-acceptance.md). Run `agent-router agent-guide` to print the self-onboarding instructions.

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

Complete state ownership and DNS/TLS instructions are in the guide. Client and federation traffic uses HTTPS port 443. The admin API and database are not exposed. Matrix federation additionally needs compatible connectors for the application-specific A2A events.

## Verification and boundaries

```sh
npm run typecheck
npm test
npm run build
```

The [0.5 CLI execution report](docs/verification/matrix-cli-work-2026-09-07.md) verifies both peers using the CLI without an A2A server, including claims, approval, progress/results, clarification, cancellation and restart/offline recovery. The existing two-homeserver lab checks native client data and the optional A2A service path. A dedicated Codex fixture separately verifies real runtime session restoration.

This is alpha software. E2EE/key recovery, SSO/OAuth, a graphical client and distributed execution failover are not implemented. Use one execution device per Matrix identity; other devices must not claim the same work. The agent host controls starting/resuming the model and stopping its tools; `claim --wait` supplies work to an agent that is already running.

Code is Apache-2.0. Synapse is an independently deployed upstream dependency with its own license. See [architecture](docs/architecture/decisions/0002-matrix-communication.md) and [security](SECURITY.md).
