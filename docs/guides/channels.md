# Message channels

A managed Agent can receive Matrix tasks and email at the same time. The mail
adapter reads and replies to email; the channel router identifies visitors,
checks invocation policy, records conversations and submits work to the existing
worker queue. Mail credentials stay in the Agent service, not the model process.

This release provides an AgentMail adapter and a channel-neutral adapter contract
in `src/channels/types.ts`. Existing Matrix authentication and contact policy
continue to operate. Other IM and mail providers require their own adapters;
cross-channel identity linking, automatic Agent selection, and an approval UI
are not included. Each configured entry currently targets one local managed Agent.

## Configure an existing mailbox

Store `AGENTMAIL_API_KEY` in an ignored `.env` file readable only by its service
account. Supply it to the Agent service process through its environment. Do not
put the key in the channel configuration, worker environment, logs or Git.
Use an existing inbox and a scoped key with inbox/message read and message send
permissions. This adapter never creates inboxes, signs up accounts, manages
webhooks, or accesses other inboxes.

Set `AGENT_CHANNELS_CONFIG_FILE` to an operator-owned JSON file:

```json
{
  "entries": [{
    "id": "business-mail",
    "kind": "agentmail",
    "account": "helper@example.com",
    "apiKeyEnv": "AGENTMAIL_API_KEY",
    "agentId": "11111111-1111-4111-8111-111111111111",
    "accessMode": "read-only",
    "enabled": true,
    "rules": [{
      "id": "staff",
      "match": { "domains": ["example.com"], "operations": ["invoke"] },
      "decision": "allow"
    }]
  }]
}
```

Use the target Agent's actual UUID. Deploy the accompanying updated Codex worker
before enabling mail. Its claimed work now carries a server-authored `execution`
field; the worker must enforce `accessMode` using the native sandbox. Mail defaults
to `read-only`; `workspace-write` is an explicit operator choice. This is not
per-file isolation: readers can still access files visible to that execution
environment. Deploy separate workers and filesystem boundaries for different data
trust domains. Router invocation permission cannot replace a harness's file/tool
permissions. Matrix tasks without an execution override retain their configured
worker behavior.

On Linux containers that cannot create nested namespaces, a pinned Codex build
that still supports Landlock can explicitly use `CODEX_USE_LEGACY_LANDLOCK=1`.
This selects a different sandbox implementation, not an unsandboxed fallback.
Verify that repository reads succeed and writes are denied on the deployed
kernel. The compatibility flag is deprecated upstream; validate it again before
upgrading Codex. Unsupported sandbox execution must fail, never downgrade access.

An entry's account, adapter kind, target Agent and execution mode are pinned in
the registry. Changing any requires a new entry ID, so an old conversation never
silently moves to another account, Agent or access boundary. Policy rules may be
changed in the file and take effect after a service restart. `enabled: false`
stops intake and requests cancellation of unfinished entry work.

## Rules and confirmations

Rules run in listed order; the first match wins. Conditions within one rule are
ANDed; values within a condition are alternatives. Match fields are `channelKinds`,
`entryIds`, `visitorIds`, `subjects`, `domains`, `agentIds`, and `operations`.
The only current operation is `invoke`; these rules do not claim to authorize
individual model tools. Decisions are `allow`, `ask`, and `deny`; no match means
`ask`. Mailbox subjects and domains are canonical lowercase strings, with exact
domain matching, not suffix matching. Empty match conditions match everyone.

AgentMail must provide structured `authentication_results.dmarc: "pass"` before
automatic execution or confirmation is permitted. Domain authentication does not
prove a real-world person or link an email account to an IM identity. Raw
`Authentication-Results` headers cannot assert trust. Spam, blocked,
unauthenticated, trash, sent, automated and self-originated mail are excluded.
Unverified mail remains pending for diagnosis; allowing its From address does not
override a failed/missing authentication result.

The owner API below uses the existing owner's Bearer session. Instance/worker
tokens and other owners cannot access these controls. Let `BASE` be
`/_agent-router/v1/agents/AGENT_ID/channels/ENTRY_ID`:

| Operation | Owner API |
| --- | --- |
| Inspect configured entries and health | `GET /_agent-router/v1/agents/AGENT_ID/channels` |
| See visitors and decisions | `GET BASE/visitors` |
| See pending requests | `GET BASE/events?state=pending&limit=100` |
| Allow or deny one request | `POST BASE/events/EVENT_ID/decision` with `{"decision":"allow"}` or `deny` |
| Set a visitor decision | `POST BASE/visitors/VISITOR_ID/decision` with `inherit`, `allow`, `ask`, or `deny` |
| Resume after fixing a permanent provider error | `POST BASE/resume` |

A one-request confirmation binds to the saved message, target and conversation,
not future emails. A matched deny rule and blocked visitors take precedence over
manual approval. An explicit
`ask` rule still requires per-request confirmation even for a visitor allowed by
an earlier manual decision. Visitor `inherit` uses the configured rules; visitor
`ask` requires confirmation even when a rule would allow. Blocking a visitor
requests cancellation and suppresses results, but cannot undo side effects.

## Conversations and delivery

The first activation time is persisted. Existing mailbox history is not executed.
The adapter scans the inbox in pages, checking provider creation time rather than
the sender-controlled Date header, and repeats the scan every 30 seconds. Each
page is persisted before advancing its cursor. Large inboxes require more pages
and therefore take longer; this first version uses polling, not WebSocket push.

Entry, sender and mail thread jointly identify a Router conversation. Another
sender in the same mail thread gets a separate context; Matrix and email histories
are not automatically merged. Follow-ups are serialized. An Agent asking for
additional input keeps its task; a completed task's follow-up creates a new task
in the same context. The worker owns the mapping to the native Agent session.

Mail text uses AgentMail's extracted new text when available. Attachments are
listed explicitly as unread by default; HTML-only rendering is not implemented.
An entry may set `fullInput: true` to preserve the UTF-8 body and retrieve up to
10 TXT/Markdown attachments from authenticated mail, with a combined 1 MB limit.
The worker receives these as `documents`; unsupported or oversized inputs are
explicitly reported unread. Oversized inline previews are visibly truncated. The model is never told
it has read an attachment that was not supplied.

Replies target only the captured original sender, never a changed Reply-To or
original CC/BCC list. Completed answers, requests for input, and safe failure
notices are sent through the original mail conversation. Queued reply bodies and
delivery IDs are stored before sending. Retries use the same AgentMail
`Idempotency-Key`; lost task receipts reuse the original Router message ID.
Neither mechanism guarantees arbitrary model/tool side effects exactly once.
An uncertain reply older than one day requires operator review.

Provider 4xx errors other than 429 halt the entry; 401/403 are not retried or worked
around. Temporary errors back off; 429 honors Retry-After. Entry health exposes
safe error codes, not provider bodies, tokens or mail contents. Once the underlying
issue is resolved, the owner can explicitly resume. Model process crash recovery
retains the existing worker's behavior and never silently reruns uncertain work.

AgentMail API references: [messages](https://docs.agentmail.to/api-reference/inboxes/messages/list),
[replies](https://docs.agentmail.to/api-reference/inboxes/messages/reply),
[idempotent sends](https://docs.agentmail.to/idempotency).


## Deferred work and outgoing files

A worker can run `agent-router defer CLAIM_ID 'Waiting for an external service'`
to free its foreground slot while retaining the original claim for later completion.
The task remains working, and tasks in the same conversation stay serialized.
New input invalidates stale completion; cancellation still requires acknowledgement.
Claims, documents and deferred state survive service restarts.

Use `agent-router reply CLAIM_ID 'Please see the attachment.' --attachment ./report.pdf`
for channel results, repeating `--attachment` for up to 8 files / 4,000,000 raw bytes
in total. Files and completion receipts commit atomically. Task views contain file
metadata; the delivery ledger retains the bytes and idempotency key for retries.
Attachment updates accept up to 6 MB of JSON after authentication. Other request
limits remain unchanged. Files are retained with task and delivery records.

## Observe execution from another client

The authenticated Agent owner can observe tasks without becoming another channel
consumer or receiving a Host credential. All paths below start with
`/_agent-router/v1/agents/:agentId/communication`:

| Method and path | Contract |
| --- | --- |
| `GET /tasks` | Task state, cancellation request, channel/message origin, run bindings and delivered reply IDs. Filter by `connectionId`, `target` or `conversationId`; use `limit` (1–100) and the returned `next` as `before` for older tasks. |
| `GET /runs/:claimId` | Bound Host run and its calls, including original inputs, results, status and deadline. |
| `GET /runs/:claimId/events?after=0&limit=200` | Host events with unchanged sequence numbers and payloads. Pass the returned `cursor` on the next request. Drain `hasMore`; explicitly surface `historyTruncated`. |
| `POST /runs/:claimId/calls/:callId/result` | `{ "result": <native response> }`. Resolve an interaction in that exact run; the Host decides expiry, repeated results and conflicts. |
| `POST /tasks/:taskId/cancel` | `{}`. Request cancellation through the durable work queue; observe the run for acknowledgment. |

`claimId` identifies a particular execution attempt, `taskId` the routed task,
`conversationId` the Router conversation, and `runId`/`sessionId` the Host objects.
Owner private conversations can span channels, so use the immutable source
`connectionId`/`target`/`messageId` when attaching a run to a channel timeline.
`replyMessageIds` identifies generated answer updates; `interactionMessageIds`
identifies textual interaction fallbacks. Other Agent messages remain independent.

These routes require the Agent owner's account token. Worker credentials and other
accounts cannot observe or answer them. They validate the run/session binding and
do not expose provider reply-route credentials. They neither wake a sleeping
execution environment nor replay a run. Unavailable environments return an error;
Host remains the authority for retained event history and native decisions.

The same primitives are available to trusted embedders through the exported
`RunObservation`, `CommunicationTask`, `RunReference` and `TaskFilter` types. A product
supplies its own authorization boundary when using embedded objects. A client can
reuse `@olorinm/agent-host/interactions` to describe and answer a native request and
`@olorinm/agent-ui/agent-host` to display it; Router does not prescribe a UI.
