# Project status and versioning

Agent Router is alpha software. Interfaces can still change between minor releases and the project has not received an independent security audit.

## Matrix implementation

[ADR 0002](architecture/decisions/0002-matrix-communication.md) selects Matrix homeservers for communication and federation. The Matrix runtime is implemented: official Matrix SDK synchronization, SQLite inbox/outbox and execution ledger, separate reception/execution permissions, CLI, official A2A REST/JSON-RPC/SSE gateway, scoped context/task mappings, and a persistent runtime fixture with optional Codex session restoration. See the [operator guide](guides/matrix.md) and [application event profile](spec/matrix-events-v1.md).

The isolated two-Synapse/PostgreSQL conformance stack verifies bidirectional delivery, retries, contexts, input-required continuation, artifacts, cancellation, request approval, offline receipt, restart, and history gaps. It does not constitute a public multi-datacenter deployment, production cutover, or automatic migration of old identities and active tasks. E2EE, global discovery, GUI, distributed execution ownership, and automatic uncertain-acceptance reconciliation remain out of scope.

## Retained legacy runtime

- official A2A v1 REST and JSON-RPC server bindings;
- official A2A client transport selection;
- authenticated Agent Cards and registry administration;
- PostgreSQL Task and push-notification stores;
- transactional Outbox and RabbitMQ delivery;
- retries, dead-letter handling, SSE, push, cancellation, and Task mapping;
- Federation Profile 1.0 discovery, JWT/JWKS trust, policy, callbacks, and recovery polling;
- endpoint validation and DNS-rebinding protection;
- local deterministic end-to-end demo.
- standalone Go CLI with Router discovery, OS-keychain authentication, one-time enrollment, directory search, official A2A calls, and credential lifecycle management;
- one-time, scoped, atomically consumed agent enrollment tokens.

## Not yet claimed

- production stability or backwards compatibility before `1.0.0`;
- high-availability orchestration;
- an independent security audit;
- interoperability with a separately developed Federation Profile implementation;
- IETF, A2A, Matrix, W3C, or other standards-body endorsement;
- a global public directory, payments, end-to-end encryption, or remote-user identity proof.

## Version layers

Compatibility claims must name all applicable layers:

```text
A2A wire protocol: 1.0
Matrix application event profile: 1 (new path)
Agent Router Federation Profile: 1.0
Agent Router implementation: 0.3.x (Matrix); 0.2.x (legacy)
```

The implementation follows semantic versioning after `1.0.0`. Before then, a minor release may change Router-owned administration or federation interfaces. Patch releases must not intentionally change their documented behavior.

Any federation-breaking change requires a new profile version, updated conformance cases, and an explicit negotiation or transition design. It must not silently alter version 1.0 semantics.
