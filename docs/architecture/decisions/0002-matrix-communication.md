# ADR 0002: Matrix communication and A2A execution adapters

- Status: accepted, implemented and verified against the complete client acceptance checklist
- Date: 2026-09-07
- Implementation: 0.4, Matrix only

## Decision

Use unmodified Matrix homeservers for identities, rooms, persisted messages, client synchronization, federation and private account data. Synapse is the tested homeserver. Use the official Matrix SDK as the HTTP/authentication client and the official A2A SDK at execution and caller boundaries.

The user explicitly removed the requirement to support the previous custom Router. Its Go CLI, account registry, JWT/JWKS federation, PostgreSQL task schema, RabbitMQ delivery, migration scripts and old compatibility data are removed. No automatic account, credential or task migration is provided.

## Ownership of data and behavior

| Layer | Responsibility |
| --- | --- |
| Matrix homeserver | Registration/login/device tokens, room state and history, native direct/ignored-user/read markers, private account data and federation |
| Matrix client | Invoke those APIs, maintain a rebuildable local communication cache, expose CLI/HTTP/event streams |
| Execution adapter | Local reception/execution policy, A2A Task/Artifact state and cancellation, durable acceptance ledger, runtime context binding |
| Runtime driver | Start/resume the actual agent, preserve its real session, apply tool permissions and cancellation |

Contact notes and tags are stored in per-contact private account-data events under `io.agentrouter.contact.<digest>`. Deletion writes a tombstone; a fresh client does not resurrect deleted entries. Separate keys avoid overwriting unrelated contacts edited on different devices. Execution permission is never downloaded from contact metadata.

Direct-room associations use standard `m.direct`. Native room membership is authoritative; a forged account-data association cannot redirect a conversation to a different peer. Both participants can use their own local conversation identifier to send ordinary messages or initiate A2A tasks in the same room. Runtime context bindings are keyed by room and authenticated sender. Task IDs remain scoped to their initiating side.

Blocking uses `m.ignored_user_list` and is rechecked before execution. Unblocking resets local automatic execution to ask. Room history and private read markers stay with Matrix. `say` sends ordinary `m.room.message` text, which never implicitly starts a model; `send` emits the versioned A2A request event.

## Receipt and recovery

Incoming account data, room cache, timeline notifications, task records and the /sync cursor commit together. Limited history is paginated before advancing the cursor. Outgoing text and A2A events use durable outboxes and stable transaction IDs.

A fresh communication cache can restore server-held contacts, rooms, messages and read markers. Historical requests downloaded without a corresponding local execution ledger require explicit review and are not automatically executed. This is not execution-owner failover. Use one active execution connector per Matrix identity; additional clients can run without a backend.

Known accepted tasks resume polling after restart. An interrupted or unknown acceptance is marked uncertain, never blindly resent. Matrix delivery does not guarantee exactly-once external side effects. Restoring a Matrix room does not itself restore Codex/other model state.

## Deployment and scope

Root `compose.yaml` deploys Synapse/PostgreSQL/Caddy. `deploy/matrix/compose.connector.yaml` deploys a separate outbound connector. The lab deploys two independent homeservers with dedicated test CA and databases, plus deterministic A2A fixtures. Codex conformance has a standalone optional image.

Native directory and profile APIs are exposed with the homeserver's own visibility rules. We do not describe local execution policy as hiding a Matrix identity. E2EE/key recovery, SSO/OAuth, a graphical client, universal runtime migration and distributed execution ownership remain explicitly unsupported.

## Acceptance

The [complete client checklist](../../verification/matrix-client-acceptance.md) covers native account data across devices, ordinary text, bidirectional same-room interaction, directory/profile APIs, blocking, read markers, event observation, fresh-device recovery and the existing A2A regression suite. Deployment and test reports must distinguish actual public HTTPS tests from the same-host federation lab.

Public review has not been posted during this local implementation. Evidence is maintained in the repository without secrets; publication follows the contribution process separately.

## Upstream references

- [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)
- [Direct messaging](https://spec.matrix.org/latest/client-server-api/#direct-messaging)
- [Ignoring users](https://spec.matrix.org/latest/client-server-api/#ignoring-users)
- [Client configuration/account data](https://spec.matrix.org/latest/client-server-api/#client-config)
- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Synapse](https://github.com/element-hq/synapse)

The project code and Matrix SDK use Apache-2.0. Synapse is independently deployed under its upstream AGPL-3.0-or-later/commercial licensing options.
