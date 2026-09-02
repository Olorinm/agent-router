# ADR 0001: OpenGrove Router Federation v1

- Status: accepted
- Federation profile version: `1.0`
- A2A wire version: `1.0`

## Context

One Router already provides authenticated Agent registration, an A2A v1 server, a durable PostgreSQL task ledger, and RabbitMQ delivery. Federation must let independently operated Routers exchange A2A tasks without a central server and without inventing a second message protocol.

The trust boundary is a Router domain. A remote Router asserts the `sub` inside its JWT; the receiving Router does not independently prove that remote user. Allow/deny policy, replay protection, future quotas, and future billing therefore use the issuer domain as their principal.

## Decision

```text
caller / local Agent
        |
        | official A2A v1
        v
Router A -- PostgreSQL Outbox --> RabbitMQ
        |
        | 1. resolve @domain through .well-known
        | 2. fetch private Agent Card with JWT Bearer
        | 3. official ClientFactory message/send
        v
Router B -- PostgreSQL Outbox --> RabbitMQ --> local Agent
        |
        | official A2A push notification + fresh JWT Bearer
        v
Router A task / SSE / artifact history
```

### 1. Discovery

Every federating address domain serves:

```http
GET https://{domain}/.well-known/opengrove-router
```

with:

```json
{
  "baseUrl": "https://agents.example.com",
  "federationVersion": "1.0",
  "jwksUrl": "https://agents.example.com/federation/v1/jwks.json"
}
```

`baseUrl` and `jwksUrl` must have the same origin. The address domain is the discovery authority, but its well-known document may delegate to a different Router origin, as in other federated systems.

### 2. Server credentials

Routers use Ed25519 domain keys and publish their public keys as a standard JWKS. Every cross-Router HTTP call uses a newly issued JWT Bearer with:

- `iss=https://{source-domain}`;
- `sub={local identity}@{source-domain}`;
- `aud={target Router origin}`;
- `iat`, `nbf`, `exp`, and `jti`;
- lifetime no longer than five minutes;
- `kid` selecting a key from the issuer JWKS.

The receiver verifies the signature, issuer, audience, lifetime, allowlist, and a durable `(issuer, jti)` replay claim. This is an A2A Card-declared bearer scheme; no custom HTTP/JWS signature header is introduced.

The active public key and optional additional public-only Ed25519 keys are published together. This permits a new `kid` to be announced before signing switches, and the previous public key to remain during the bounded overlap.

### 3. Address and private Card resolution

`localpart@domain` resolves through the domain discovery document and then:

```http
GET {baseUrl}/a2a/agents/{localpart}/card
Authorization: Bearer <short-lived domain JWT>
```

Card access and A2A calls use the same domain allowlist. The Router never exposes federated cache entries through its local `/v1/agents` directory. A local Agent appears in that list only when its administrator registered it locally; there is no federation-wide Agent enumeration endpoint.

### 4. Delivery and idempotency

The Router sends the remote Card through the official A2A `ClientFactory`; `DefaultRequestHandler`, `restHandler`, and `jsonRpcHandler` remain the receiving transport. RabbitMQ only carries the original SDK Message between the local server and its delivery worker.

The A2A `messageId` is the client idempotency key. For a federated caller, the receiver deduplicates by `(issuer domain, messageId)`. It does not add a private idempotency header.

### 5. Return path

Router A includes an official A2A task push-notification configuration in `message/send`. Router B serializes updates with the SDK v1 push serializer and signs every callback request with a fresh domain JWT. Router A accepts a callback only when its URL origin and dedicated callback path match Router A's own well-known `baseUrl`.

Push is the normal return path. Periodic official `tasks/get` polling is retained only as recovery when a webhook is lost or unavailable.

### 6. Policy

Inbound and outbound federation are default-deny. An administrator must explicitly set a domain to `allowed`; `blocked` records an explicit denial. The policy applies before remote JWKS or Card retrieval, so an unknown domain cannot make the Router fetch arbitrary URLs.

### 7. Cancellation and task mapping

`tasks/cancel` is forwarded by the official client. PostgreSQL stores the local Router task, remote domain, remote task/context IDs, original federation subject, delivery state, callback time, and recovery-poll time. This is routing state, not a second Task state machine.

## Security invariants

- Discovery, JWKS, Cards, callbacks, and Agent endpoints do not follow redirects.
- DNS is resolved and checked immediately before connection; the connection is pinned to a checked public address to prevent DNS rebinding.
- Private, loopback, link-local, multicast, reserved, and transition IP ranges are rejected in production.
- A federated caller can call only Agents local to the receiving Router; it cannot use that Router as a relay to a third domain.
- Terminal local tasks and terminal delivery bindings never regress when callbacks arrive late or out of order.
- Card endpoint existence and skills are not disclosed before authentication and domain policy checks.
- Inbound Card, task, and callback traffic is rate-limited by issuer domain, not by its self-asserted `sub`.

## Deliberate non-goals

- public global directory, Rooms, invitations, or Matrix-compatible wire protocol;
- custom request-signature headers;
- central identity proof for remote `sub` values;
- settlement. A future WW order or protocol reference may be carried as an A2A metadata extension without changing this envelope;
- Agentgateway in the first deployment. It can later sit in front for richer RBAC, limits, and telemetry without replacing this federation profile.

## Reused implementations

- `@a2a-js/sdk`: A2A objects, Agent Cards, REST/JSON-RPC, task handling, SSE, push serialization, cancellation, client transports, and version validation;
- `jose`: JWT, EdDSA, JWKS, `kid`, and claim validation;
- `undici`: controlled outbound HTTP and connection pinning;
- `ipaddr.js`: public/private/reserved IP classification;
- PostgreSQL: TaskStore, replay claims, policy, mappings, and transactional Outbox;
- RabbitMQ: durable delivery, confirms, acknowledgements, retries, and dead letters;
- Express and Caddy: application routing and public TLS ingress.

Custom code is limited to the registry, WW identity adapter, PostgreSQL SDK stores, persistent queue bridge, Router-to-remote task mapping, domain policy, and the thin JWT federation profile above.
