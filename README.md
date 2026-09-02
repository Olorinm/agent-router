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
- encrypted employee endpoint bearer credentials;
- domain allow/deny policy and a thin JWKS/JWT federation profile for Router-to-Router authentication.

The Router does not receive employee production data or general-purpose provider keys.

## Federation v1

Federation is an optional, default-deny server profile layered on the official A2A v1 transport. It provides Matrix-like independent domain operation without using the Matrix wire protocol: `worker@company-b.example` is discovered through that domain, its private Card is fetched with a short-lived JWT, and the task is sent with the official A2A client. Results normally return through official A2A push notifications; polling is recovery only.

The complete decisions and security invariants are in [ADR 0001](docs/architecture/decisions/0001-federation-v1.md).

To enable a production node:

1. Make `https://$AGENT_ADDRESS_DOMAIN/.well-known/opengrove-router` reach this Router. The common single-host setup uses the same hostname for `AGENT_ADDRESS_DOMAIN`, `PUBLIC_BASE_URL`, and `ROUTER_HOST`; a split-host setup may publish or proxy only the well-known document from the address domain.
2. Build once, then run `npm run federation:keygen` to create `secrets/federation-private-key.pem`. The key is ignored by Git and written with mode `0600`. On Linux Docker hosts, make the `secrets` directory and its files owned by UID/GID `1000:1000`; that is the non-root `node` user running the Router image.
3. Set `FEDERATION_ENABLED=true` and start the common Compose deployment.
4. Allow each trusted peer explicitly with the admin API:

```sh
curl -X PUT \
  -H "Authorization: Bearer $WW_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"allowed"}' \
  https://agents.example.com/v1/federation/domains/company-b.example
```

Both Routers must allow each other. No remote Agent is copied into the public/local directory; it is resolved and cached only when an authenticated local caller addresses it explicitly.

For zero-downtime key rotation, generate the next private key, export its public JWKS with `npm run federation:jwks -- <next-private-key>`, and publish that file through `FEDERATION_ADDITIONAL_JWKS_FILE` before switching the active private key. During the overlap, the JWKS contains both `kid` values. Keep the previous public key published until all five-minute tokens and peer JWKS caches have expired; never place another private key in the additional JWKS file.

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

## Deployment

`compose.yaml` runs Caddy, Router, Postgres, and RabbitMQ. Postgres and RabbitMQ are confined to an internal Docker network; the Router gets a separate outbound network; only Caddy publishes TCP/UDP 443.

The checked-in deployment is the single supported layout for every operator. There are no environment-specific variants. Copy `.env.example` to `/opt/agent-router/.env`, replace every example value, set mode `0600`, then enable `deploy/agent-router.service`.

`ROUTER_HOST` is the public TLS hostname, `PUBLIC_BASE_URL` is its absolute HTTPS URL, and `AGENT_ADDRESS_DOMAIN` is the domain used in registered addresses such as `writer@agents.example.com`. `WW_BASE_URL` must point to the account service whose `/v1/users/me` endpoint authenticates Router administrators.

Generate independent values for `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD`, and `MASTER_ENCRYPTION_KEY_BASE64`. The real `.env`, federation signing keys, database contents, and RabbitMQ contents stay on the deployed server and are ignored by Git; all non-secret deployment behavior remains in this repository.

The verifier under `examples/codex-employee` is intentionally a separate Compose project and network. Its container is non-root, read-only, capability-free, and mounts only a dedicated Codex home; its workspace remains a private `tmpfs` mount. Put the verifier account's `auth.json` at `examples/codex-employee/state/codex/auth.json`, keep the directory private and the file mode at `0600`, and make both writable only by container UID `1000`. The dedicated mount lets Codex persist rotated login tokens without exposing any other host directory.

If the verifier needs an outbound proxy, set `VERIFIER_HTTPS_PROXY` and `VERIFIER_HTTP_PROXY` to an internal proxy sidecar address. Keep that sidecar's configuration mounted only in the sidecar; the employee receives the proxy URL but never the node credentials or configuration file.

For a verifier behind an inbound firewall, `compose.quick-tunnel.yaml` uses a digest-pinned Cloudflare `cloudflared` sidecar. The sidecar initiates an outbound tunnel and can reach only the employee on the verifier's dedicated Docker network. Quick Tunnel hostnames are ephemeral and are intended for this verification scenario, not a permanent production employee address.
