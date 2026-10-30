# Native sessions and product-authored work

Router routes work into Host sessions. Codex continues to own its threads, turns,
history, memory generation, skills and approvals. Router does not implement a model loop
or a background scheduler.

## Public component boundary

`HostPort` and `HttpAgentHost` preserve the Host protocol for run submission, lookup,
typed input items, settings, compaction, native session management, runtime discovery,
and the trusted native request/notification/event/request-response extension. Native
responses are returned unchanged; `ChannelHttpError.nativeError` retains native error
code/data when supplied by Host. A method in this interface does not prove that every
kernel/version implements it. Consult Host's runtime discovery and native errors.

`HttpAgentHost.connect()` reads the Host health capability flags. Stable `requestKey`
submission requires an advertised `runIdempotency` capability. Without it, a keyed
submission fails before dispatch; Router never drops the key to start weaker work.

The raw native extension is for trusted embedding code. It is not exposed as an arbitrary
method endpoint to models or owner HTTP clients. Host must independently allow the method
in its server-owned runtime configuration.

## Product-authored work

After authenticating the owner, an embedding product can obtain the agent's session port:

```ts
router.service.owned(agentId, owner);
const sessions = (await router.service.runtime(agentId)).extension?.sessions;
if (!sessions) throw new Error("host_sessions_unavailable");
const event = await sessions.submit({
  eventId: "rule-42-occurrence-7",
  sessionId: "rule-42",
  input: "Check the authorized data and return a result.",
  admission: {
    kind: "schedule", owner, agentId, reference: "rule-42-v2",
    toolGrants: {},
  },
});
```

`WorkSessions` is scoped to one agent's Router store. Its public `sessionId` identifies a
Router context; it is not a raw native thread ID. A stored mapping selects the Host session
and runtime. `list` and `getSession` inspect this directory without waking an execution
environment. `read`, `history`, `native` (bounded session actions), `fork`, and `steer`
operate on that stored mapping. A supplied native thread ID cannot select another session.

`submit` writes the work event and server-authored admission in the same transaction as the
durable work item. Reusing an event ID with different input is rejected. `lookup`/`get`
return the saved task status and latest observed answer without contacting Host. `wait`
uses a cursor over these saved observations. It never resumes or wakes a native thread.
Owner-authored native input items and per-turn context are forwarded separately from the
session's stable instructions. Scheduled work requires explicit tool grants. Delegated and
scheduled work enters Codex as native `toolOutput`, with its actual product source
(`mau.work_sessions` or `mau.proactive_work`), instead of a human user message. Codex does
not allow typed input and standalone tool output in the same turn. For internal work,
Router verifies requested skill names and paths against the native catalog and includes
those references for on-demand loading; this does not force native skill injection.
Other typed items on an internal delivery are rejected before submitting a run.

`HostAdmission` is trusted embedding metadata, never a model-visible authorization token.
The product's Host decorator consumes and strips it; the default `HttpAgentHost` also
strips it before the Host HTTP request. Owner channel admission is issued for a
verified owner private chat, and for the owner's turn in a Matrix group whose members are
only the owner and the owner's own agents. Mixed groups, peer messages and forged context
IDs do not receive it. Each group keeps its own session; it never joins the private main session.
The product must enforce expiry, operation grants and call budgets at tool execution.

The owner HTTP API offers bounded `/communication/sessions` management and
`/communication/work-events` submission/observation. HTTP callers cannot supply an
admission; Router constructs a user-origin admission from their authenticated identity.
Internal schedule/delegation admission is available only to trusted embedding code.

## Execution and delivery

The Host worker retains each claim while releasing its foreground slot with the existing
defer mechanism. Different contexts run concurrently; a single context remains serialized.
Every run and long-running tool has an independent observer, so waiting does not block the
dispatch loop. Native run IDs and original claim IDs remain stable after a Router restart.
An uncertain submission is only reconciled by its original request key; it is never blindly
executed again.

The default budget is four regular runs plus a fixed reserve of four dependency runs, for
a hard ceiling of eight live Host runs. A product tool calling `wait` supplies its actual
`waitingRunId`, `waitingReference`, and `waitingCallId` from the trusted execution context;
these are never model arguments. Each valid waiting parent permits one extra dispatch,
only for an explicitly awaited task, within that fixed ceiling. The parent remains live
at Host. A contextual wait without a cursor waits for the next saved change; terminal or
unknown results return immediately. Waiting on the same busy context or requesting more capacity at the hard ceiling
returns an explicit error instead of silently waiting for work that cannot start. After a
wait returns or times out, already-started children keep running; new regular work waits
until capacity is free. At the worker boundary, `maxConcurrentRuns` and
`maxDependencyRuns` configure these two budgets (the latter defaults to the former).
This bounds dependency nesting; it does not promise unlimited parallel child sessions.
Unknown submissions also retain their capacity reservation because the native run may
exist. They are never silently removed or resubmitted; reconciliation or explicit owner
closure is required to release that reservation.

An internally delivered turn can continue an existing owner session while retaining its
native tool catalog. It does not inherit a channel reply route. Channel tools are denied
for that turn unless it has an admitted channel message. Products similarly retain stable
business tool definitions while authorizing each call from the current run's admission.

Internal work does not automatically send a chat message. After inspecting a result, the
product may call `validateTarget` and `deliver({eventId,targetSessionId,text})`. Only a
known owner private conversation is accepted. The stable delivery intent and the channel
outbox are committed together. `lookupDelivery` reports the actual receipt: `queued` is
not delivery, and an uncertain result is not automatically resent as a new message.

`skills`, `configureSkill`, `memoryStatus`, `readMemory`, and `memoryMode` use explicit
native methods. Skill discovery always supplies the selected runtime's trusted working
directory from Host inspection as `cwds`; callers cannot choose another workspace. Skill
configuration accepts only paths returned by that native skill catalog. Memory thread operations resolve the Router/Host binding before supplying
the native ID. Native experimental/disabled methods return their actual failure rather
than fabricated success. These controls are not a filesystem or cross-owner memory
isolation mechanism; that boundary belongs to the configured Host environment.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Install separate Router and Host tarballs into an empty consumer directory, then run:

```sh
node scripts/verify-native-sessions.mjs /absolute/path/to/consumer
```

That check imports only public installed package exports and exercises Router → Host HTTP
→ a native app-server protocol subprocess. Four parent runs fill the regular budget. Each
tool forks its active native session before the unfinished turn, then actually waits while
Router starts and observes the children using the bounded reserve; their results unblock
the parents. It then restarts Router, continues the same native parent
thread and pages native history. The child's original tool-output source is retained.
This is deterministic
protocol evidence, not live-model, live-account or cloud-environment acceptance.
