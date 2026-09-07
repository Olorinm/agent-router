# Agent Router Matrix application event profile 1

Status: implemented alpha profile. This document specifies the connector's application events; homeserver federation uses the unchanged Matrix protocol. It is not a standardized A2A protocol binding. A2A boundaries use the official SDK and wire version 1.0.

## Identity and rooms

Each connector serves one configured Matrix user ID, one durable SQLite database, and one execution adapter: the default CLI inbox or an optional configured A2A service. An independent operator may use any compatible homeserver. The initial tested implementation is unmodified Synapse.

A new conversation creates a private direct room and invites the target. Its `m.room.history_visibility` is `invited`. A state event with type `io.agentrouter.conversation`, empty state key, and content `{"version":1,"purpose":"a2a","encrypted":false}` identifies the profile. This marker does not confer execution permission.

The sender MUST wait until the target's `m.room.member` state is `join` before publishing a request. This avoids racing the remote join and creating a message whose predecessor state has no receiving homeserver. Until then, the invitation resides on Matrix and the request resides in the sender's durable outbox. Once the room has been joined, requests can be delivered while the receiving connector is offline. The homeserver must remain reachable, or federation queues until it recovers.

Profile 1 supports unencrypted rooms over authenticated HTTPS only. Homeserver operators can read payloads. Connectors MUST refuse to publish or execute profile events in a room with `m.room.encryption`; they do not implement cryptographic device/key recovery. Enabling encryption concurrently with a send is outside this profile: use rooms dedicated to this profile, not rooms whose encryption policy is being changed. This is not end-to-end encryption.

## Requests

Event type: `io.agentrouter.a2a.request`. Content:

```json
{
  "version": 1,
  "requestId": "unique-operation-id",
  "recipient": "@worker:b.example",
  "taskId": "source-task-id",
  "contextId": "source-conversation-id",
  "operation": "send",
  "body": {"message":{"messageId":"unique-message-id","role":"ROLE_USER","parts":[{"text":"hello"}]}}
}
```

`operation` is `send` or `cancel`. A send body is official A2A `SendMessageRequest.toJSON`; a cancel body is empty. The outer task and context IDs are source identities, never trusted destination task/session IDs. Nonempty inner message task/context IDs MUST agree with their outer IDs. Remote push configuration and tenant selection are forbidden. Profile consumers MUST validate the authenticated Matrix event sender rather than trusting a sender field in content.

Requests are deduplicated by receiving identity (database), room, authenticated sender, and request ID. Reusing this scope with different content is a protocol error. Event replay is additionally deduplicated by room and Matrix event ID. A source gateway persists idempotency by target and A2A Message ID; different payloads for the same key are rejected.

## Responses

Event type: `io.agentrouter.a2a.response`. Content:

```json
{
  "version": 1,
  "requestId": "unique-operation-id",
  "recipient": "@caller:a.example",
  "taskId": "source-task-id",
  "sequence": 1,
  "result": {"task":{"id":"destination-task-id","contextId":"destination-context-id","status":{"state":"TASK_STATE_WORKING"}}}
}
```

Exactly one of `result` and `error` is present. `result` is official `SendMessageResponse.toJSON` carrying either a Task or Message. An error has `code` (up to 100 characters) and `message` (up to 500). The sequence increases durably across all responses for the same room, sender, and source task, including continuation and cancellation requests.

The receiver MUST match the actual Matrix sender, recipient, room, original request ID, and source task ID. Invalid results MUST NOT consume a sequence number. Old sequences cannot overwrite newer state, and terminal source tasks cannot regress. A2A Task and Message IDs are translated back to the source namespace. Source user Message IDs are restored to avoid duplicate history entries. Task artifacts retain official A2A structure; the receiving connector publishes durable CLI snapshots or polls accepted external tasks for changes.

Events MUST fit in 48,000 UTF-8 JSON bytes including envelope. Large outputs should use file references; connectors do not automatically fetch or upload arbitrary artifact URLs. If a backend returns an oversized result, its accepted task binding is still recorded and an explicit result-delivery error is returned; execution is not retried.

## Permission and execution ledger

Contact metadata uses private Matrix account data. Local policy has independent `receive` and `execution` values (`allow`, `ask`, `deny`). The API defaults both to `ask`. `receive=allow` accepts invitations automatically. `execution=allow` permits execution; joining a room and adding a contact do not grant that permission. Unknown invitations remain in the invitation inbox. Once joined, unknown tasks enter the request inbox. An explicit approval releases one request; a denial or block returns rejection. Blocking reception also blocks execution in existing rooms.

Incoming events, inbox records, and the `/sync` cursor commit in one SQLite transaction. A limited timeline is paginated backward to the previous seen event, with a bounded 500-page recovery limit; failures leave the cursor unchanged. Outgoing events commit before network calls and use stable Matrix transaction IDs on retry.

The destination ledger transitions from `pending` to `queued`, then `sending`, then `accepted`/`done`. With an external service, a timeout during acceptance or a crash in `sending` becomes `uncertain` and MUST NOT be automatically resent. Known external task IDs are polled after restart. Local CLI acceptance is transactional and idempotent in the same database, so interrupted `sending` resumes through that ledger. This prevents blind replay; it does not provide exactly-once external side effects. Profile 1 does not implement operator reconciliation of unknown external acceptance; inspect the endpoint and start a new operation only after resolving its outcome.

Task bindings are scoped by connector identity, room, authenticated sender and source task. Runtime contexts are keyed by room and authenticated sender, so another communication device can continue the same room using its local conversation identifier. Database metadata binds the execution endpoint URL; switching endpoint identity requires explicit migration or a new database. A native runtime driver separately persists the destination A2A context to its real session (the Codex fixture uses `exec resume`). A Matrix room alone cannot restore model context.

Cancellation is scoped to the original authenticated sender and room. A cancellation received before a queued send prevents invocation. After external acceptance, the connector calls the mapped destination task's A2A cancellation operation. Local unclaimed work is canceled immediately; active claims receive a cancellation flag and remain working until the worker acknowledges stopping. If external acceptance is uncertain, cancellation is also unconfirmed; it must not report success. An offline cancellation remains queued even if the caller's HTTP wait expires.

## Local CLI execution

These are authenticated local operator operations, not new Matrix wire events. `inbox` lists pending approvals and accepted work. `claim --worker NAME` atomically claims one permitted work item, marks its official Task working and returns input, recent history, context and a unique claim ID. Each worker owns at most one active claim; active work in the same context is serialized. Repeating a claim with the same worker recovers its assignment. Claims do not expire or automatically transfer to another worker.

`progress`, `reply`, `need-input`, `fail` and `cancelled` update the official Task and enqueue a durable snapshot in the same transaction. A reply produces an official Artifact. A digest of the action and payload makes an exact retry idempotent, even after the claim closes. Different writes from closed claims are rejected. New input increments the work revision; a current owner MUST claim again to acknowledge that input before completing. Terminal tasks cannot accept further input. Large results are rejected before committing, leaving the claim available for a smaller result or file reference.

Claim policy is rechecked from local permissions and native blocking. Unclaimed requests with revoked permission wait for approval; blocked requests are rejected. Blocking active work requires cancellation acknowledgement. CLI and external execution adapters cannot run simultaneously for one connector. Existing task/context records cannot be silently moved to an unrelated adapter. Runtime model startup, session restoration and tool execution remain the agent host's responsibility.

## A2A gateway

The authenticated gateway exposes an Agent Card, REST, JSON-RPC, and SSE under `/agents/{encoded Matrix ID}/`. It implements send, stream, get, list, subscribe, and cancel. Blocking sends wait for terminal or input/auth-required state; `returnImmediately=true` returns the source task. SSE emits Task, artifact updates, and status updates. Source tasks are scoped by target so another target path cannot read them. Gateway Cards describe routed delivery, not a remotely fetched capability catalog. Push notifications and extended Cards are explicitly unsupported.

The gateway API token authorizes its owner to initiate work and manage the connector. It is separate from the Matrix access token and destination A2A token. No endpoint token appears in Matrix events. Destination Card URLs and advertised interfaces must remain at the explicitly configured origin; local HTTP/private addresses require explicit local mode.

## Deployment limits

One execution device per identity is supported. Additional devices may restore communications but MUST NOT claim or execute the same requests. A renewable database lease prevents ordinary duplicate starts sharing that database, with a 30-second stale lease period. Separate databases or cloned Matrix tokens are not a distributed ownership mechanism. Do not run two execution connectors for the same Matrix account. Retention, compaction, execution failover, key rotation and global discovery remain separate work. The former custom Router protocol and its migration paths have been removed.

## Native client data and ordinary messages

The client uses standard `m.direct`, `m.ignored_user_list`, `m.fully_read`, private read receipts, user profiles and user-directory APIs. Personal contact metadata uses global account data of type `io.agentrouter.contact.<sha256(JSON-encoded Matrix ID)>`, containing `{version:1,address,note,tags,deleted?}`. There are no execution credentials or permissions in these events. Deletion retains a tombstone, not room deletion. Local policy defaults to ask on a new device. Removing a contact revokes local policy; unblocking never restores automatic execution.

Standard `m.room.message` text is stored and displayed but is not converted into an executable A2A request. Both participants may initiate ordinary messages or new A2A tasks in the same direct room. Native membership and the actual peer, not an arbitrary m.direct mapping, establish the conversation target.

Account data, room/timeline cache and /sync checkpoints commit with durable receipt. On a new cache's initial sync, historical requests without an execution ledger are pending with `history_restored_without_execution_state`; they must not run automatically even when local policy otherwise permits that sender. Restoring communications is distinct from migrating runtime sessions or claiming execution ownership.

Conformance: `test/cli-work.test.ts`, `test/matrix.test.ts`, `test/matrix-social.test.ts`, `scripts/matrix/cli-work-check.mjs`, `scripts/matrix/lab-verify.sh` and `scripts/matrix/client-check.mjs`. See the [operator guide](../guides/matrix.md) and [ADR 0002](../architecture/decisions/0002-matrix-communication.md).
