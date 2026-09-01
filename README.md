# OpenGrove Agent Router

The Agent Router is an independent A2A v1 delivery service. It exposes each registered employee as a router-owned A2A Agent Card, durably accepts tasks, and forwards them to the employee's private A2A endpoint.

The official `@a2a-js/sdk` owns protocol parsing, REST and JSON-RPC bindings, task semantics, cancellation, and client transport selection. Router-specific code owns:

- WW `/v1/users/me` authentication for OpenGrove administrators;
- independent one-time machine credentials for agent callers;
- agent address and Agent Card registration;
- Postgres task state, task bindings, audit records, and transactional Outbox;
- RabbitMQ per-agent durable queues, retries, and dead-letter queues;
- encrypted employee endpoint bearer credentials.

The Router does not receive employee production data or general-purpose provider keys.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Production layout

`compose.yaml` runs Caddy, Router, Postgres, and RabbitMQ. Postgres and RabbitMQ are confined to an internal Docker network; the Router gets a separate outbound network; only Caddy publishes TCP/UDP 443.

Create `/opt/agent-router/.env` with mode `0600`, then enable `deploy/agent-router.service`. Secrets must be generated independently for Postgres, RabbitMQ, and `MASTER_ENCRYPTION_KEY_BASE64`.

The verifier under `examples/codex-employee` is intentionally a separate Compose project and network. Its container is non-root, read-only, capability-free, and mounts only a Codex authentication secret; its workspace and Codex home are private `tmpfs` mounts.
