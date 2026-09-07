# ADR 0002: Matrix communication with A2A execution adapters

- Status: accepted; Matrix connector, A2A gateway, CLI, and two-homeserver conformance lab implemented
- Date: 2026-09-07
- Supersedes ADR 0001 for the future communication architecture, not the existing Federation Profile 1.0 wire contract

## Context

The intended product lets agents obtain an address, contact agents on another domain, receive messages while offline, and continue a conversation across multiple tasks. Account registration, login and device credentials reuse the homeserver's native Matrix APIs. Agents also need visibility controls, personal contacts, and permission to execute incoming requests.

The current Router implements authenticated A2A task routing and a project-specific federation profile. It has durable task state and delivery retries, but no general client inbox synchronization or complete conversation model. Forwarding currently clears the destination task and context identities; the Codex verifier also runs each request independently. Neither a stored conversation ID nor a Matrix room by itself restores an agent's internal history.

Matrix already defines room events, history synchronization, device access, invitations, and homeserver federation. The absence of native A2A task semantics is a reason to build an adapter, not sufficient reason to reimplement the communication infrastructure.

## Decision

Use Matrix for the new communication path and retain official A2A interfaces at agent execution and compatibility boundaries. Initially evaluate an independently deployed, unmodified Synapse homeserver for each operator domain.

| Component | Responsibility |
| --- | --- |
| Matrix homeserver | Matrix identities, room membership, persistent events, client synchronization, and server-to-server federation |
| Agent connector | Outbound client connection, durable receipt, execution policy, identity/conversation/task mappings, and result publication |
| A2A adapter | Official Agent Cards, Messages, Tasks, Artifacts, task operations, and supported streaming or push behavior at A2A boundaries |
| Agent runtime driver | Start or resume the actual agent, load its history, manage execution, and translate cancellation |
| Product layer | Agent visibility, contacts, request inbox, and permissions to execute |

A2A is an agent interaction protocol. It does not establish a Matrix connection or start a stopped Codex process. A runtime without a native A2A server needs a driver and, where A2A access is required, an A2A wrapper.

```text
Agent / A2A caller A
        |
        | official A2A at the compatibility boundary
        v
Connector / gateway A
        |
        | Matrix Client-Server API
        v
Homeserver A <---- Matrix Server-Server API ----> Homeserver B
                                                       ^
                                                       | outbound client sync
                                                       |
                                               Connector B
                                                       |
                                                       | official A2A, potentially on loopback
                                                       v
                                               Agent runtime B
```

Responses and task updates return through the same Matrix conversation. A gateway can expose them to an ordinary A2A caller through the official SDK.

### Deployment and connectivity

- An independent domain operator deploys a Matrix homeserver, its database, HTTPS ingress, and domain discovery. Synapse is the first implementation to evaluate; another compatible homeserver need not be excluded.
- An ordinary agent registers an identity on an existing homeserver and runs its connector. It does not need its own homeserver or publicly reachable inbound endpoint.
- The first connector uses the Client-Server API and outbound synchronization. A homeserver Application Service is an optional later mechanism for operator-managed gateways; its server-to-service callbacks do not solve NAT access for a laptop connector.
- A local connector may call an A2A endpoint on loopback. The existing policy for arbitrary remote endpoints must not be weakened globally to enable this explicit local mode.
- Matrix federation connects homeservers. Structured A2A-over-Matrix interactions additionally require compatible connectors; an arbitrary Matrix user or client does not automatically implement our task operations.

### Identity, conversations, and protocol boundaries

- Registration, password authentication, invitation verification, logout and token refresh stay with Synapse/Matrix. The CLI implements the supported standard client flows through the official SDK, not a separate Router account service. Its first supported flows are password login and registration-token/dummy UIA; SSO/OAuth and additional verification UIs remain separate integration work.
- Persist each agent's device credentials and local connector settings in a private profile, with atomic credential updates and one active local owner. A server-side logout revokes the device session while retaining the local task/context history. A saved login alone does not start the execution endpoint or connector.

- Use a Matrix user ID such as `@writer:agents.example` as the Matrix identity. Existing `writer@agents.example` addresses can remain aliases only through explicit, verified mappings; do not infer ownership from matching strings.
- Start with an explicitly selected direct room as a product conversation. The same pair of agents can have multiple conversations.
- Scope the execution context mapping by receiving agent, room, authenticated caller, and endpoint identity. Map it to the destination A2A context and runtime session/history. Do not use a room ID as an unchecked destination A2A context ID.
- Persist task correlations separately. A completed task can be followed by a new task in the same context; an input-required task can receive a continuation addressed to the existing task.
- Carry structured requests and results in a versioned Matrix application event profile, preserving official A2A data objects through supported SDK serialization. This profile is project-specific, not a claim that Matrix is a standard A2A binding.
- Define that profile and its conformance cases before implementing wire-visible events. Matrix homeserver federation remains standard Matrix; no second Router-to-Router federation is required for this path.

### Delivery and execution

- Separate message receipt, permission to execute, execution start, and task completion. Saving a contact or joining a room does not by itself authorize tool execution.
- Persist relevant events in the connector inbox before advancing its sync checkpoint. Recover limited sync gaps through history pagination and deduplicate by receiving identity and event ID.
- Persist outgoing events and stable transaction IDs so publishing can resume after a crash. Preserve correlations when reflecting A2A state changes to Matrix to avoid message loops.
- Keep a durable execution ledger and a claim/lease if multiple devices serve one agent. Matrix event delivery does not guarantee exactly-once external side effects.
- Recover known accepted A2A tasks after a connector restart instead of blindly resending their original request. Record uncertain acceptance explicitly.
- Apply execution policy before starting a model. Unknown senders can remain pending under a product request-inbox policy; Matrix invitations alone are not that policy.
- Keep endpoint credentials out of room events and Cards shared with peers. The initial synthetic-data experiment must explicitly identify any unencrypted rooms; it must not claim end-to-end encryption support. Encrypted production operation requires connector key storage, decryption, and recovery work.

## Migration and acceptance

1. Record this direction without changing existing deployments or Federation Profile 1.0 behavior. Track public review through the repository's contributing process; implementation and deployment evidence are maintained locally until publication.
2. Specify the Matrix application event profile and build an isolated two-homeserver demo with deterministic agents, explicit permissions, and independent persistent stores.
3. Verify bidirectional cross-domain requests, offline receipt, history-gap recovery, connector restart, duplicate delivery, two turns in one context, input-required continuation, artifacts, and cancellation before and after execution starts. Check all final results at the original caller.
4. Expose a gateway to an ordinary official-SDK A2A client and verify task get/list/cancel and any declared streaming/push capabilities without requiring that caller to understand Matrix.
5. Add real runtime session restoration and the product contact/visibility/request policies. Plan identity, credential, history, and active-task migration explicitly before selecting a production cutover.

Keep existing active tasks on their original transport until completion or explicit cancellation. Select a transport for new conversations rather than sending the same work down both paths. Leave old task history readable. Retire the custom federation modules only after the Matrix path passes acceptance and the migration/rollback procedure is exercised.

## Reuse and costs

Retain or adapt the A2A SDK integration, task ledger, endpoint authentication and validation, execution isolation, CLI, and test cases. Evaluate queue and callback code by responsibility: execution durability can remain useful even when Matrix replaces inter-domain message transport. Registry and credentials require migration rather than automatic reuse.

The new stack adds a homeserver and an application event adapter, with operational and licensing obligations. Synapse uses AGPL-3.0-or-later or a commercial license; the Matrix specification and matrix-js-sdk use Apache-2.0. Keep the homeserver independently deployed and evaluate the exact dependencies and distribution model when packaging the product.

## References

- [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)
- [Matrix Server-Server API](https://spec.matrix.org/latest/server-server-api/)
- [Matrix Application Service API](https://spec.matrix.org/latest/application-service-api/)
- [A2A multi-turn interactions](https://a2a-protocol.org/latest/specification/#34-multi-turn-interactions)
- [Synapse](https://github.com/element-hq/synapse)
- [ADR 0001](0001-federation-v1.md)
