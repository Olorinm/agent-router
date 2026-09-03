# ADR 0001: Agent Router Federation Profile 1.0

- Status: accepted
- Federation profile: `1.0`
- A2A wire protocol: `1.0`

## Context

A single Router provides authenticated Agent registration, official A2A v1 interfaces, a PostgreSQL Task ledger, and reliable RabbitMQ delivery. Independent operators also need to exchange work without a central directory or a second message protocol.

The difficult parts are discovery, server identity, private Card access, retry idempotency, asynchronous return delivery, cancellation, and abuse policy. The security boundary must be an operator domain because a remote Router alone vouches for the user named in its token.

## Decision

Adopt the separately published [Agent Router Federation Profile 1.0](../../spec/federation-v1.md):

```text
caller / local Agent
        |
        | official A2A v1
        v
Router A -- PostgreSQL Outbox --> RabbitMQ
        |
        | .well-known discovery
        | short-lived JWT Bearer via JWKS
        | private Agent Card resolution
        | official A2A ClientFactory
        v
Router B -- PostgreSQL Outbox --> RabbitMQ --> local Agent
        |
        | official A2A push + fresh JWT Bearer
        v
Router A Task / SSE / Artifact history
```

The profile makes these choices:

1. `localpart@domain` addresses and `/.well-known/agent-router` discovery;
2. Ed25519 domain keys, public JWKS, and request-scoped JWT Bearer credentials;
3. inbound and outbound federation denied unless an operator explicitly allows the peer domain;
4. authenticated one-Agent Card resolution with no federation-wide list;
5. official A2A delivery with `(issuer domain, target agent, messageId)` idempotency;
6. push-first return delivery with official Task polling as recovery;
7. official cancellation using persistent local-to-remote Task mappings.

## Rejected alternatives

### Custom HTTP request signatures

Rejected because they would require non-standard client interceptors and duplicate timestamp, nonce, and key-rotation behavior available through short-lived JWTs and JWKS.

### Public Agent directory

Rejected because private Card existence and capabilities are sensitive, and federation does not require global enumeration.

### Polling as the normal return path

Rejected because it increases latency and cross-domain load. A2A push notification already provides the appropriate asynchronous mechanism.

### Agentgateway in the core path

Deferred. A traffic gateway may later add richer RBAC, limits, and telemetry, but it does not replace the registry, durable Task ledger, Outbox, or offline delivery buffer.

## Consequences

- The A2A wire layer remains usable by official clients and servers without a private Message or Task format.
- Operators retain domain-level control and accept explicit bilateral federation.
- Federation Profile 1.0 is project-specific and requires independent interoperability testing before broader standardization claims.
- Address-domain keys and stable discovery become operational identity and must be backed up and rotated carefully.
- A Router can read Task content; this design does not provide end-to-end encryption.
