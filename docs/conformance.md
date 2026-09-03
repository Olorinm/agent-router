# Conformance

Conformance has two independent layers:

1. A2A 1.0 wire behavior, implemented through the official SDK;
2. Agent Router Federation Profile 1.0 behavior, implemented by the Router.

A product must not describe the second layer as A2A conformance.

## Required federation cases

| Area | Required assertion |
| --- | --- |
| discovery | exact profile version accepted; unknown version rejected |
| discovery safety | HTTP, redirects, unsafe addresses, and mismatched JWKS origins rejected |
| keys | Ed25519 public JWKS accepted; private material and invalid `kid` rejected |
| authentication | valid issuer, subject, audience, times, algorithm, and profile claim required |
| replay | the second use of `(iss, jti)` rejected after durable first claim |
| policy | unknown and blocked domains denied before remote fetching |
| privacy | Card existence and capability data hidden before authentication and policy checks |
| locality | a Router cannot be used to relay to a third domain |
| delivery | official A2A client and server bindings exchange the Message |
| idempotency | retries with the same `(issuer domain, messageId)` do not create duplicate work |
| return path | push callback origin and path match discovery and stored mapping |
| recovery | failed push can recover through official Task polling |
| cancellation | cancellation reaches the mapped remote Task |
| ordering | late updates do not regress terminal Task state |

## Current implementation coverage

Automated tests cover cryptography, endpoint policy, federation JWT/JWKS exchange, replay rejection, Card protection, push serialization, Task stores, streaming, delivery, mapping, and cancellation.

Run the local suite:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Run the full disposable PostgreSQL and RabbitMQ integration check only with both safeguards:

```sh
INTEGRATION_CHECK_CONFIRM=disposable-database \
DATABASE_URL=postgres://.../agent_router_integration \
npm run check:integration
```

The database name must end in `_integration`. Disposable queues are removed afterward.

## Interoperability status

The current implementation has not yet been tested against a separately developed implementation of Federation Profile 1.0. Until that happens, it should claim implementation coverage, not independent interoperability.

Future language-neutral test vectors should include discovery documents, public JWKS fixtures, valid and invalid JWT claim sets, callback URL cases, Message idempotency cases, and Task ordering sequences. Fixtures must contain only synthetic keys and `.example` domains.
