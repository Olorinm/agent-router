# OpenGrove Agent Router

The Agent Router is an independent A2A v1 delivery service. It exposes each registered employee as a router-owned A2A Agent Card, durably accepts tasks, and forwards them to the employee's private A2A endpoint.

The official `@a2a-js/sdk` (currently locked to the latest stable release, 1.1.0) owns protocol objects and serialization, Agent Cards, REST and JSON-RPC bindings, task semantics, SSE, cancellation, push-notification delivery, protocol-version handling, standard errors, and client transport selection. Router-specific code owns:

- WW `/v1/users/me` authentication for OpenGrove administrators;
- independent one-time machine credentials for agent callers;
- agent address and Agent Card registration;
- name/description/skill discovery plus endpoint, Card, and status updates;
- Postgres implementations of the official TaskStore and PushNotificationStore interfaces;
- encrypted push-notification configurations, task bindings, audit records, and transactional Outbox;
- RabbitMQ per-agent durable queues, retries, and dead-letter queues;
- Router task to remote task mappings;
- encrypted employee endpoint bearer credentials.

The Router does not receive employee production data or general-purpose provider keys.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run check:integration` is deliberately guarded: it runs only when
`INTEGRATION_CHECK_CONFIRM=disposable-database` and the PostgreSQL database
name ends in `_integration`. It validates migrations, registry skill search,
agent updates, PostgreSQL task persistence, encrypted push configuration,
delivery through the SDK's `DefaultPushNotificationSender`, the durable
PostgreSQL Outbox and RabbitMQ path, `ClientFactory`, SSE events, Router/remote
task mapping, and remote cancellation. Its disposable RabbitMQ queues are
removed after each run.

## API boundary

Administrative registry endpoints are the only Router-owned HTTP API:

- `GET /v1/agents?q=<name-or-skill>` lists and searches employees;
- `POST /v1/agents` registers an official Agent Card and returns a one-time machine credential;
- `GET /v1/agents/:address` reads a registration;
- `PATCH /v1/agents/:address` updates its Card, endpoint credential, display fields, or active status.

Messages, task reads and listings, cancellation, SSE streaming, and push-notification configuration use the official A2A v1 REST or JSON-RPC routes below each virtual employee address. The Router does not define private `/v1/messages` or `/v1/tasks` protocol endpoints.

## Production layout

`compose.yaml` runs Caddy, Router, Postgres, and RabbitMQ. Postgres and RabbitMQ are confined to an internal Docker network; the Router gets a separate outbound network; only Caddy publishes TCP/UDP 443.

Create `/opt/agent-router/.env` with mode `0600`, then enable `deploy/agent-router.service`. Secrets must be generated independently for Postgres, RabbitMQ, and `MASTER_ENCRYPTION_KEY_BASE64`.

The verifier under `examples/codex-employee` is intentionally a separate Compose project and network. Its container is non-root, read-only, capability-free, and mounts only a Codex authentication secret; its workspace and Codex home are private `tmpfs` mounts. Keep the host authentication file owned by `root:root` with mode `0640`; the container's non-root process receives supplemental group `0` solely to read that file and immediately copies it to its private Codex home with mode `0600`.

For a verifier behind an inbound firewall, `compose.quick-tunnel.yaml` uses a digest-pinned Cloudflare `cloudflared` sidecar. The sidecar initiates an outbound tunnel and can reach only the employee on the verifier's dedicated Docker network. Quick Tunnel hostnames are ephemeral and are intended for this verification scenario, not a permanent production employee address.
