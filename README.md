# Agent Router

Matrix communication and federation for agents, with official [A2A 1.0](https://a2a-protocol.org/latest/specification/) execution interfaces.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](docs/project-status.md)

Give each agent a Matrix address such as `@writer:agents.example`. Its connector receives messages through outbound synchronization, applies local permissions, calls the agent's A2A endpoint, and returns Task updates through the same conversation. An ordinary agent does not need a public inbound endpoint or its own homeserver.

## Architecture

```text
A2A caller → connector A → Matrix homeserver A
                                  ⇅ standard Matrix federation
                          Matrix homeserver B ← connector B → A2A agent B
```

Matrix owns identity, room membership, persistent events, offline history, and homeserver federation. Connectors own contacts, request approval, durable execution receipt, and the mapping between conversations, A2A tasks, and runtime sessions. A2A objects and REST/JSON-RPC/SSE bindings come from the official SDK.

The [versioned application events](docs/spec/matrix-events-v1.md) carried inside Matrix are an Agent Router profile, not a standardized A2A transport binding.

## Start a connector

Use Node.js 24 and an existing Matrix account:

```sh
npm ci
npm run build
cp .env.matrix.example .env.matrix
# Configure the homeserver, Matrix ID, credential file paths, and optional local A2A endpoint.
node --env-file=.env.matrix dist/matrix/index.js
```

From another terminal:

```sh
node --env-file=.env.matrix dist/cli/matrix.js doctor
node --env-file=.env.matrix dist/cli/matrix.js contact-add '@writer:other.example' --allow-receive
node --env-file=.env.matrix dist/cli/matrix.js send '@writer:other.example' 'Write an introduction.'
```

Adding a contact, allowing reception, and allowing automatic execution are separate choices. Unknown room invitations stay pending; after a room is accepted, its requests wait for execution approval. `--allow-execution` grants automatic execution explicitly.

`send` waits by default; `--detach` returns a queued Task. Use `--context-id` for another task in the same conversation, and also `--task-id` to supply input to an existing task. CLI operations include contacts, invitations, request approval, task get/list/cancel, and status diagnostics.

See the [complete operator guide](docs/guides/matrix.md) for credentials, permission choices, container deployment, and ordinary A2A client integration.

## Run the federation checks

The reproducible lab deploys two unmodified Synapse servers, independent PostgreSQL databases, two connectors, and two persistent A2A agents. It uses TLS with a dedicated private CA and needs no model account.

Follow the initialization steps in the [guide](docs/guides/matrix.md), then run:

```sh
bash scripts/matrix/lab-verify.sh
```

It verifies both directions through official A2A clients, idempotency, same-context turns, input-required continuation, artifacts, cancellation before and after execution, invitation/request approval, SSE, connector/runtime restart, offline delivery, and limited-sync history recovery. An optional Codex fixture additionally verifies native session restoration after a process restart.

## Scope and migration

This is an implemented alpha path. Profile 1 uses unencrypted Matrix rooms over TLS: homeserver operators can read message content. E2EE and key recovery, multi-device execution failover, a graphical inbox, remote skill discovery, and automatic migration of old identities/history are not implemented.

One active connector serves one Matrix identity and one durable database. If backend acceptance is unknown after a network failure, it is recorded explicitly and never automatically executed again. This is not an exactly-once side-effect guarantee.

The default Node `start` and `dev` entrypoints now run Matrix. The previous Router server, Go CLI, root Dockerfile, and Compose stack remain available for existing tasks and rollback; use `npm run start:legacy`. Existing deployments and identities are not silently switched. Their documentation is preserved in the [legacy guide](docs/guides/legacy-router.md).

Synapse is deployed independently under its own AGPL/commercial licensing. This repository and the Matrix JavaScript SDK use Apache-2.0.

## Development

```sh
npm run typecheck
npm test
npm run build
```

- [Matrix application event profile](docs/spec/matrix-events-v1.md)
- [Matrix operator and migration guide](docs/guides/matrix.md)
- [Architecture decision](docs/architecture/decisions/0002-matrix-communication.md)
- [Project status](docs/project-status.md)
- [Verification report](docs/verification/matrix-2026-09-07.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
