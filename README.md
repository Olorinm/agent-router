# Agent Router

Durable, authenticated, and optionally federated routing for [A2A Protocol](https://a2a-protocol.org/latest/) agents.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![A2A](https://img.shields.io/badge/A2A-1.0-5b5bd6.svg)](https://a2a-protocol.org/latest/specification/)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](docs/project-status.md)

Agent Router gives independently hosted agents stable addresses such as `writer@agents.example.com`. It publishes official A2A v1 interfaces for those addresses, persists Task state, and reliably delivers work to each agent's real A2A endpoint.

It is infrastructure around A2A, not a fork of the A2A wire protocol.

> **Status:** alpha. Local delivery is implemented and integration-tested. Federation is an experimental Agent Router profile, not an A2A, Matrix, or IETF standard. The project has not received an independent security audit.

## Why Agent Router

A2A defines Agent Cards, Messages, Tasks, Artifacts, streaming, cancellation, and push notifications. It deliberately leaves deployment concerns such as shared directories, stable domain addresses, offline delivery, and federation policy to operators.

Agent Router supplies those operational pieces:

- domain-scoped addresses and a private Agent registry;
- official A2A v1 server and client transports;
- durable Task and push-configuration stores in PostgreSQL;
- transactional enqueueing and RabbitMQ delivery;
- retries, dead letters, cancellation, and remote Task mapping;
- optional domain discovery, JWT/JWKS authentication, and federated return delivery.
- a standalone `agent-router` CLI for discovery, enrollment, directory search, and A2A calls.

The result resembles a homeserver for agents. Agents can use different frameworks, live on different machines, and remain under independent administrative control.

## Architecture

```text
caller
  |
  | official A2A v1
  v
writer@agents.example.com
  |
  v
+---------------- Agent Router ----------------+
| A2A SDK handlers | registry | trust policy   |
| PostgreSQL Task ledger + transactional Outbox |
+----------------------+------------------------+
                       |
                       v
                 RabbitMQ queue
                       |
                       v
                Delivery Dispatcher
                       |
                       | official A2A v1
                       v
                 real agent endpoint
```

The address names the Router responsible for the agent, not the machine that runs it. Callers use the Router-owned Agent Card and never need the private endpoint credential.

The Delivery Dispatcher is Router infrastructure, not an agent or an AI worker. It takes accepted queue items, calls the target through the official A2A client, records the remote Task ID, and releases its dispatcher slot. Task completion then arrives by A2A push notification or is recovered with `tasks/get`.

## CLI

Download the standalone binary for macOS, Linux, or Windows from [GitHub Releases](https://github.com/Olorinm/agent-router/releases). It does not require Node.js or a local Router checkout.

```sh
agent-router profile add work agents.example.com
printf '%s' "$ADMIN_TOKEN" | agent-router auth login --token-stdin
agent-router admin enrollment create \
  --address writer \
  --endpoint-origin https://worker.example.net
```

The agent operator can then validate and register an independently hosted A2A agent with the one-time token:

```sh
agent-router agent validate https://worker.example.net/.well-known/agent-card.json
printf '%s' "$ENROLLMENT_TOKEN" | agent-router agent register \
  --address writer \
  --card https://worker.example.net/.well-known/agent-card.json \
  --enrollment-token-stdin

agent-router directory search writing
agent-router send writer@agents.example.com "Draft a two-sentence introduction." --wait
```

Profiles contain only non-secret Router locations. Credentials go to the operating-system credential store. Headless containers can inject `AGENT_ROUTER_TOKEN`; one-time outputs can be captured with `--json --no-store`. See the complete [CLI guide](docs/guides/cli.md).

## Interoperability boundary

| Layer | Authority | Implementation |
| --- | --- | --- |
| Message, Task, Part, Artifact, and Agent Card | A2A v1 | official `@a2a-js/sdk` types |
| REST, JSON-RPC, SSE, cancellation, push, errors, and version checks | A2A v1 | official SDK handlers |
| outbound agent calls | A2A v1 | official SDK `ClientFactory` |
| registry, PostgreSQL adapters, queue bridge, and Task mapping | Agent Router | local implementation |
| domain discovery, trust, and callbacks | Agent Router Federation Profile 1.0 | HTTPS, JWT, and JWKS |

Agent Router does not introduce private Message or Task lookalikes. A2A operations use the endpoints and objects produced by the official SDK.

This release targets A2A wire protocol 1.0 and currently resolves `@a2a-js/sdk` 1.1.0.

## Try it locally

The demo starts an isolated Router, PostgreSQL, RabbitMQ, and a deterministic A2A echo agent. It needs Docker Compose v2 and Node.js 24, but no domain, TLS certificate, external identity provider, or model account.

```sh
npm ci
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml \
  up --detach --build router echo-agent
npm run demo
```

Expected result:

```json
{"address":"echo-...@local.test","result":"Echo: hello through the router"}
```

Remove the disposable stack and its data with:

```sh
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml down --volumes
```

`.env.demo` contains public, intentionally insecure test values and binds the Router only to loopback. Never reuse it for an Internet deployment.

## Production deployment

The supported production profile uses Docker Compose with Caddy, PostgreSQL, and RabbitMQ. It exposes only HTTPS; the database and broker remain on an internal network.

Start with the [deployment guide](docs/guides/deployment.md), then review the [security policy](SECURITY.md) and [configuration reference](docs/reference/configuration.md).

Administrator authentication supports:

- a generic bearer-token UserInfo endpoint for shared deployments; or
- a constant-time checked static administrator token for small, controlled installations.

Neither mode depends on a particular account provider.

## Federation

Federation lets independently operated Routers exchange standard A2A Tasks without a central directory:

```text
worker@company-b.example
        |
        | /.well-known/agent-router
        v
Router A  <---- official A2A + short-lived JWT ---->  Router B
```

Federation is disabled by default. Both operators must explicitly allow the other domain. Agent Cards and task endpoints use the same access policy, and private agents are never exposed through a global list.

The normative profile is [Agent Router Federation Profile 1.0](docs/spec/federation-v1.md). Its design lineage and differences from Matrix, AT Protocol, and ActivityPub are documented separately in [Design lineage](docs/design-lineage.md).

## Documentation

| Document | Audience |
| --- | --- |
| [Local demo](docs/guides/local-demo.md) | first-time users |
| [Production deployment](docs/guides/deployment.md) | operators |
| [Register and call an agent](docs/guides/register-agent.md) | agent integrators |
| [CLI](docs/guides/cli.md) | people, scripts, and agent operators |
| [HTTP surface](docs/reference/http-api.md) | client and operations developers |
| [Configuration](docs/reference/configuration.md) | operators |
| [Federation Profile 1.0](docs/spec/federation-v1.md) | implementers |
| [Conformance](docs/conformance.md) | interoperable implementations |
| [Project status and versioning](docs/project-status.md) | adopters and contributors |
| [ADR 0001](docs/architecture/decisions/0001-federation-v1.md) | architecture reviewers |
| [Security policy](SECURITY.md) | operators and security researchers |

## Repository map

```text
src/                 server, stores, delivery dispatcher, and federation
cli/                 standalone Go CLI using the official A2A Go SDK
migrations/          PostgreSQL schema
docs/spec/           interoperable Agent Router profiles
docs/guides/         deployment and integration guides
docs/reference/      APIs and configuration
examples/echo-agent/ self-contained local demonstration agent
examples/codex-employee/ isolated Codex-based end-to-end verifier
deploy/              optional systemd integration
```

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Protocol-affecting changes require an issue and an architecture decision or specification update before implementation.

## License

Licensed under the [Apache License 2.0](LICENSE).
