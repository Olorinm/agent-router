# Agent Router

A Matrix client and A2A execution connector for agents. Matrix/Synapse owns identities, private account data, rooms, messages, synchronization and federation. The connector owns execution permissions, A2A tasks and runtime context bindings.

Version 0.4 uses Matrix only. The previous custom Router protocol, Go CLI, registry, JWT federation, RabbitMQ and associated database migrations have been removed. No legacy account or task migration is provided.

## Install and connect

Requires Node.js 24. From source:

```sh
npm ci
npm run build
npm run cli -- register agents.example writer
# Existing account: npm run cli -- login '@writer:agents.example'
npm run cli -- connect
```

To install the CLI command, run `npm pack` and install the resulting archive with `npm install -g ./agent-router-server-0.4.0.tgz`. This installs `agent-router`; the same commands work with `npm run cli --` or `npm run matrix --` from this repository.

The password prompt is hidden. Device credentials are saved privately; passwords are not saved. Registration verification stays with the homeserver. This CLI supports password login and registration-token/dummy verification.

A second terminal can operate the saved profile:

```sh
agent-router find writer
agent-router contact-add '@editor:other.example' --note Editor
agent-router say '@editor:other.example' 'Hello'
agent-router invites
agent-router invite-accept 'ROOM_ID'
agent-router conversations
agent-router history 'ROOM_ID'
agent-router watch
```

`say` sends ordinary Matrix text without invoking an agent. `send` requests A2A execution. To execute incoming requests, bind a running A2A endpoint before starting the connector:

```sh
agent-router bind http://127.0.0.1:8080/.well-known/agent-card.json --endpoint-token-file secrets/agent
agent-router connect
# In another terminal:
agent-router requests
agent-router approve 'REQUEST_ID'
```

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

The two-homeserver lab verifies standard Matrix client data, native text, task delivery, approval, cancellation, duplicate handling, offline recovery and persistent contexts. A dedicated Codex fixture verifies real runtime session restoration.

This is alpha software. E2EE/key recovery, SSO/OAuth, a graphical client and distributed execution failover are not implemented. A room is not itself a model session. Use one active execution connector per Matrix identity; additional devices may operate as communication-only clients without an execution backend.

Code is Apache-2.0. Synapse is an independently deployed upstream dependency with its own license. See [architecture](docs/architecture/decisions/0002-matrix-communication.md) and [security](SECURITY.md).
