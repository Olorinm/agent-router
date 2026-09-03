# Design lineage

Agent Router reuses patterns from mature open protocols without claiming wire compatibility with them.

| Source | Pattern reused | Important difference |
| --- | --- | --- |
| [A2A v1](https://a2a-protocol.org/latest/specification/) | Agent Cards, Messages, Tasks, Artifacts, bindings, streaming, push, and cancellation | A2A is the actual agent protocol and semantic authority |
| [Matrix Server-Server API](https://spec.matrix.org/latest/server-server-api/) | domain-owned identifiers, homeserver discovery, durable sender queues, idempotent retry, destination backoff, independent operators, and explicit server policy | no Matrix rooms, event graph, PDUs, or `X-Matrix` signatures; A2A Tasks still need remote Task mapping, result tracking, artifacts, and cancellation |
| [Matrix identifier grammar](https://spec.matrix.org/latest/appendices/#common-identifier-format) | a domain allocates and resolves its local identifiers | Agent Router uses `localpart@domain`, not Matrix IDs |
| [AT Protocol inter-service auth](https://atproto.com/specs/xrpc#inter-service-authentication-jwt) | short-lived signed JWTs with issuer, audience, expiry, key ID, and replay nonce | keys use JWKS discovery and A2A remains the application protocol |
| [ActivityPub](https://www.w3.org/TR/activitypub/) | independently operated services and asynchronous server-to-server delivery | no ActivityStreams vocabulary, actors, inboxes, followers, or social graph |
| [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) and [RFC 7517](https://www.rfc-editor.org/rfc/rfc7517) | JWT claims and JSON Web Keys | the claim profile and domain policy are Agent Router-specific |
| [Matrix client discovery](https://spec.matrix.org/latest/client-server-api/#server-discovery) | select a domain while allowing its well-known document to delegate to a service base URL | Agent Router profiles select a Router, not a Matrix homeserver |
| [Vercel CLI project linking](https://vercel.com/docs/cli/link) | an optional non-secret file associates the current directory with remote context | `.agent-router.json` contains no project ownership or deployment credential |
| [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login) | credentials are scoped to a host, entered through a hidden interactive prompt, and stored through the operating-system credential mechanism | the Router still issues the bearer credential; no browser/device flow is claimed yet |
| [Tailscale auth keys](https://tailscale.com/kb/1085/auth-keys) | short-lived, scoped enrollment secrets reduce onboarding authority | Agent Router enrollment is always one-use and creates an A2A registration, not a network node |

The design rule is to reuse standards and mature libraries for agent semantics, transports, cryptography, HTTP, databases, and queues. Custom code is limited to the registry, SDK store adapters, reliable queue bridge, Task mapping, destination policy, and the thin federation profile.

The delivery dispatcher follows the same acceptance boundary used by mature federated messaging systems: once the destination durably accepts an item, the sender releases its dispatcher slot and records the destination identifier. Agent Router then resumes the accepted A2A Task asynchronously instead of resending the Message. Matrix code is not embedded because its event graph and homeserver transaction format are not A2A Task semantics.

## Reused implementations

- `@a2a-js/sdk`: A2A objects, Agent Cards, REST/JSON-RPC, Task handling, SSE, push serialization, cancellation, clients, and version validation;
- `a2a-go/v2`: all CLI A2A Card decoding, transport negotiation, Message, Task, list, get, and cancellation operations;
- Cobra, `go-keyring`, and `x/term`: the CLI command tree, native operating-system credential storage, and non-echoing interactive secret entry;
- `jose`: JWT, EdDSA, JWKS, `kid`, and claim validation;
- `undici`: controlled outbound HTTP and address pinning;
- `ipaddr.js`: public, private, and reserved address classification;
- PostgreSQL: Task and push stores, mappings, replay claims, policy, audit logs, and transactional Outbox;
- RabbitMQ: durable delivery, confirmations, acknowledgements, retries, and dead letters;
- Express and Caddy: application routing and public TLS ingress.
