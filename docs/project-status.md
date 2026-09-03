# Project status and versioning

Agent Router is alpha software. Interfaces can still change between minor releases and the project has not received an independent security audit.

## Implemented

- official A2A v1 REST and JSON-RPC server bindings;
- official A2A client transport selection;
- authenticated Agent Cards and registry administration;
- PostgreSQL Task and push-notification stores;
- transactional Outbox and RabbitMQ delivery;
- retries, dead-letter handling, SSE, push, cancellation, and Task mapping;
- Federation Profile 1.0 discovery, JWT/JWKS trust, policy, callbacks, and recovery polling;
- endpoint validation and DNS-rebinding protection;
- local deterministic end-to-end demo.

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
Agent Router Federation Profile: 1.0
Agent Router implementation: 0.1.x
```

The implementation follows semantic versioning after `1.0.0`. Before then, a minor release may change Router-owned administration or federation interfaces. Patch releases must not intentionally change their documented behavior.

Any federation-breaking change requires a new profile version, updated conformance cases, and an explicit negotiation or transition design. It must not silently alter version 1.0 semantics.
