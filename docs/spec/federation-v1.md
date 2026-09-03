# Agent Router Federation Profile 1.0

- Status: experimental
- Profile version: `1.0`
- Required application protocol: A2A `1.0`
- Last updated: 2026-09-03

## 1. Scope

This document defines how independently operated Agent Routers discover one another, authenticate server-to-server requests, resolve private Agent Cards, deliver standard A2A work, return asynchronous updates, and forward cancellation.

It does not redefine A2A Messages, Tasks, Parts, Artifacts, transports, status transitions, push-notification objects, or errors. Implementations MUST use A2A 1.0 for those semantics.

This profile is an experimental specification maintained by the Agent Router project. It is not part of A2A, Matrix, ActivityPub, AT Protocol, or an IETF standard.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/rfc/rfc2119) when they appear in uppercase.

## 2. Terminology

- **address domain**: the DNS domain that allocates an Agent address;
- **local part**: the name to the left of `@`;
- **origin Router**: the Router accepting a request from its local caller;
- **target Router**: the Router authoritative for the destination address;
- **local agent**: an Agent registered directly on the authoritative Router;
- **federation principal**: the issuer domain, not the remote `sub` it asserts.

## 3. Agent addresses

An Agent address is `localpart@domain`.

The local part MUST match:

```text
[a-z0-9][a-z0-9._-]{0,63}
```

The complete address and DNS domain MUST be normalized to lowercase. The address domain is the authority that allocates the local part and publishes discovery. It MAY delegate serving traffic to another HTTPS origin.

## 4. Discovery

The address domain MUST serve:

```http
GET https://{address-domain}/.well-known/agent-router
Accept: application/json
```

A successful response MUST be a JSON object:

```json
{
  "baseUrl": "https://agents.example.com",
  "federationVersion": "1.0",
  "jwksUrl": "https://agents.example.com/federation/v1/jwks.json"
}
```

Requirements:

1. `baseUrl` and `jwksUrl` MUST use HTTPS.
2. They MUST have the same origin.
3. They MUST NOT contain user information or fragments.
4. A client MUST NOT follow redirects while resolving discovery or JWKS resources.
5. A client MUST reject a `federationVersion` it does not implement.
6. DNS and destination addresses MUST be validated against the security requirements in section 12 immediately before connection.

`agent-router` is an experimental, project-specific well-known suffix and is not registered in the IANA Well-Known URI registry.

## 5. Domain keys

A federating Router MUST hold an Ed25519 private key and publish the corresponding public JWK in a JWKS document at `jwksUrl`.

Each key MUST:

- use `kty=OKP` and `crv=Ed25519`;
- declare `alg=EdDSA` and `use=sig`;
- use its RFC 7638 SHA-256 JWK thumbprint as `kid`;
- omit all private key parameters.

Multiple public keys MAY be published during rotation. A receiving Router MUST select by `kid` and MUST reject unknown algorithms.

## 6. Server authentication

Every authenticated federation HTTP request MUST carry:

```http
Authorization: Bearer <JWT>
```

The source Router MUST mint a new JWT for each HTTP request. The JWT MUST be signed with EdDSA and contain:

| Field | Required value |
| --- | --- |
| `iss` | `https://{source-address-domain}` |
| `sub` | an address under the same source domain |
| `aud` | exact origin of the target Router `baseUrl` |
| `iat` | issuance time |
| `nbf` | not-before time |
| `exp` | expiry no more than 300 seconds after `iat` |
| `jti` | unpredictable identifier unique for this request |
| `agent_router_federation_version` | `1.0` |

The protected header MUST contain `alg=EdDSA`, `kid`, and `typ=JWT`.

The target Router MUST verify the signature, issuer, audience, times, profile version, subject domain, algorithm, and local domain policy. It MUST durably claim `(iss, jti)` until expiry and reject a duplicate as replayed.

The target Router trusts only that the source domain asserted `sub`. Quotas, blocking, abuse handling, and billing MUST use the issuer domain as the security principal unless a separate identity agreement exists.

## 7. Domain policy

Inbound and outbound federation MUST be denied by default.

An operator MUST explicitly allow a domain before the Router fetches its discovery document, JWKS, Agent Card, or sends it work. An explicit block MUST take precedence over cached discovery or Card data.

Both peers MUST allow one another for bidirectional Task delivery and return callbacks.

## 8. Private Agent Card resolution

After discovery and policy checks, a source Router resolves a destination local part using:

```http
GET {baseUrl}/a2a/agents/{percent-encoded-localpart}/card
Authorization: Bearer <fresh federation JWT>
```

The target Router MUST authenticate and authorize the request before revealing whether the Agent exists. It MUST return only a local Agent Card and MUST NOT use this endpoint to relay a third domain.

The Card MUST be an official A2A 1.0 Agent Card. Every advertised interface MUST share the target Router `baseUrl` origin. A client MUST treat Card contents as untrusted input and validate all interface URLs.

There is no federation-wide Agent enumeration endpoint. Cached remote Cards MUST NOT appear in the local administrative directory.

## 9. A2A delivery and idempotency

The source Router MUST select and call an interface from the resolved Agent Card using an A2A 1.0 client. Each HTTP request MUST carry a fresh federation JWT through the Card-declared bearer scheme.

The A2A Message `messageId` is the client-generated idempotency key. A target Router MUST deduplicate delivery by `(issuer domain, target agent, messageId)`. Including the target Agent permits one source message to be intentionally fanned out to multiple Agents without collision. The Router MUST NOT require a private idempotency header.

Once the target A2A server has returned a Task ID, the source Router MUST persist that ID and acknowledge its internal delivery item. Later retries MUST resume that same Task through push notifications or `tasks/get`; they MUST NOT call `message/send` again for an accepted Task. This is an at-least-once transport with idempotent acceptance, not an exactly-once transport claim.

An internal queue MAY buffer delivery, but it MUST preserve the official A2A Message and MUST NOT introduce a second public Task state machine.

## 10. Return delivery

Push notification is the normal federated return path. The origin Router supplies an official A2A push-notification configuration when sending work.

The callback URL MUST use the origin Router's discovered `baseUrl` origin and this path:

```text
/federation/v1/push/{router-task-id}
```

The target Router MUST serialize the update as an official A2A 1.0 push payload and authenticate the callback with a fresh federation JWT. The origin Router MUST verify the callback JWT and the stored Task mapping before applying the update.

Official A2A Task polling SHOULD be used only to recover from a missing or failed push callback.

## 11. Cancellation and mapping

The origin Router MUST retain a bidirectional mapping containing at least:

```text
origin Router Task ID
target domain
target Task ID
target context ID
delivery state
```

When a caller cancels an origin Task, the Router MUST use the official A2A cancellation operation for the mapped target Task. Late or out-of-order callbacks MUST NOT regress a terminal Task state.

## 12. Security requirements

Implementations:

- MUST use HTTPS for Internet federation;
- MUST NOT follow redirects for discovery, JWKS, Card, callback, or Agent URLs;
- MUST reject loopback, private, link-local, multicast, reserved, and transition address ranges for Internet deployments;
- MUST resolve and validate DNS immediately before connecting and SHOULD pin the connection to a validated address;
- MUST reject discovery, Card, and callback origin mismatches;
- MUST apply Card access and A2A access through the same domain policy;
- MUST limit inbound requests by issuer domain rather than only by source IP or asserted `sub`;
- MUST keep private signing keys and stored endpoint credentials out of logs and public documents;
- MUST NOT treat transport authentication as end-to-end encryption of Task content.

## 13. Error behavior

Before reaching an A2A handler, implementations SHOULD use:

| Status | Meaning |
| --- | --- |
| `401` | bearer token absent, malformed, expired, replayed, cryptographically invalid, or issued by a domain that is not allowed; these cases are intentionally indistinguishable |
| `403` | an authenticated principal lacks permission for an operation unrelated to domain allowlisting |
| `404` | Agent absent or deliberately undisclosed |
| `429` | issuer-domain rate limit exceeded |

Once an official A2A handler accepts a request, A2A 1.0 error semantics take precedence.

## 14. Versioning

Version 1.0 supports exact-match negotiation through the discovery document. An implementation MUST fail closed on an unknown version.

A future backwards-incompatible profile requires a new `federationVersion`, updated conformance cases, and an explicit negotiation design. It MUST NOT silently change the meaning of version 1.0.

## 15. Conformance

An implementation claiming `Agent Router Federation Profile 1.0` MUST satisfy the required behavior in this document and the cases in [`docs/conformance.md`](../conformance.md). A2A conformance and Agent Router federation conformance are separate claims and MUST be reported separately.
