# ADR 0002: Matrix communication and A2A execution adapters

- Status: accepted, implemented and verified against the complete client acceptance checklist
- Date: 2026-09-07
- Implementation: 0.6, Matrix transport, Go CLI and default CLI execution

## Decision

Use unmodified Matrix homeservers for identities, rooms, persisted messages, client synchronization, federation and private account data. Synapse is the tested homeserver. The communication service uses the official Matrix SDK and the official A2A JavaScript SDK. The Go CLI uses standard Matrix account APIs and the official A2A Go SDK; see [ADR 0003](0003-go-cli.md).

Both agents interact through our CLI. The default execution adapter stores requests in a persistent inbox and exposes claim/progress/reply operations. It converts those operations into official A2A Task states and Artifacts using the existing Matrix response transport. A separately hosted A2A service is an optional alternative, not a prerequisite. Users do not choose an A2A wire format to send work.

The user explicitly removed the requirement to support the previous custom Router. Its old custom-protocol Go CLI, account registry, JWT/JWKS federation, PostgreSQL task schema, RabbitMQ delivery, migration scripts and old compatibility data are removed. No automatic account, credential or task migration is provided.

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

A fresh communication cache can restore server-held contacts, rooms, messages and read markers. Historical requests downloaded without a corresponding local execution ledger require explicit review and are not automatically executed. This is not execution-owner failover. Use one execution device per Matrix identity; additional clients must not claim the same requests.

Local CLI acceptance, claims, revisions and result receipts are stored in SQLite transactions. Stable worker names recover lost claim responses and assignments after restart. A worker holds at most one active claim, and only one work item per context can be claimed. New input invalidates the previous claim for completion until its owner claims again. Ordered durable snapshots feed the existing response outbox. There is no claim expiry or automatic reassignment: recovering a lost worker requires its own state and the same worker name.

Unclaimed work can be canceled immediately. Running work remains working with `cancelRequested` until the agent stops and acknowledges. Blocking a sender prevents new claims and requests cancellation of active work. Permission is rechecked before claiming; storing a contact and accepting a room do not approve execution.

An external A2A service's known accepted tasks resume polling after restart. Interrupted or unknown external acceptance is marked uncertain, never blindly resent. Local transactional acceptance can safely resume through its own deduplication ledger. Neither mode guarantees exactly-once external side effects. Restoring a Matrix room does not itself restore Codex/other model state; the host starts/resumes its model and invokes the CLI.

## Deployment and scope

Root `compose.yaml` deploys Synapse/PostgreSQL/Caddy. `deploy/matrix/compose.connector.yaml` deploys a separate outbound connector. The lab deploys two independent homeservers with dedicated test CA and databases, plus deterministic A2A fixtures. Codex conformance has a standalone optional image.

Native directory and profile APIs are exposed with the homeserver's own visibility rules. We do not describe local execution policy as hiding a Matrix identity. E2EE/key recovery, SSO/OAuth, a graphical client, universal runtime migration and distributed execution ownership remain explicitly unsupported.

## Acceptance

The [client checklist](../../verification/matrix-client-acceptance.md) covers native account data across devices, bidirectional same-room interaction, directory/profile APIs, blocking, read markers, event observation, fresh-device recovery and the existing A2A regression suite. The [0.5 execution report](../../verification/matrix-cli-work-2026-09-07.md) separately verifies both peers using only the CLI without A2A execution servers. Deployment and test reports distinguish public HTTPS tests from the same-host federation lab.

Public review has not been posted during this local implementation. Evidence is maintained in the repository without secrets; publication follows the contribution process separately.

## Upstream references

- [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)
- [Direct messaging](https://spec.matrix.org/latest/client-server-api/#direct-messaging)
- [Ignoring users](https://spec.matrix.org/latest/client-server-api/#ignoring-users)
- [Client configuration/account data](https://spec.matrix.org/latest/client-server-api/#client-config)
- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Synapse](https://github.com/element-hq/synapse)

The project code and Matrix SDK use Apache-2.0. Synapse is independently deployed under its upstream AGPL-3.0-or-later/commercial licensing options.
