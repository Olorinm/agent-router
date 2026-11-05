# ADR 0005: Router-owned conversation ledger and web channel

- Status: proposed (design only, nothing implemented)
- Date: 2026-11-05
- Affects: ADR 0002 (Matrix stops being the record of conversation history), ADR 0004 (login is unchanged until phase 6)
- Scope: agent-router (ledger, delivery, web API), Mau web console (`mau/web`), Matrix adapter

## 1. Context

The Mau web console works as a Matrix client of Synapse. It logs in with `m.login.password`, long-polls
`/sync`, creates rooms with `createRoom` (groups carry the `ai.mau.room` `{kind:"group"}` state event)
and sends `m.room.message` with `m.mentions` (`mau/web/src/api/conversations.ts`). Router has no
complete transcript. The facts are spread across several places:

| Record | Where | What it holds | Gap |
| --- | --- | --- | --- |
| `communication_inbox` | per-agent `agents/<id>.sqlite`, `src/communication/core.ts` | Inbound channel messages (`InboxRecord`), state, `taskId` | Inbound only. Scanned in full on every dispatch (`entries()` + filter). |
| `communication_outbox` | same | Finals, notices, question cards, activity reactions (`OutboxRecord`) | Outbound only. No link back to a transcript position. |
| `communication_questions` / `_actions` / `_control_receipts` | same, `src/execution/host-worker.ts` | Interaction cards and button tokens | Keyed by Host call id. Only reachable through a task. |
| `communication_runs`, `communication_run_archives` | same, `src/execution/*` | `RunBinding` (claim → task → session → run), finished run archives | Separate from chat. The web console joins them through Matrix event ids (`replyMessageIds`, `interactionMessageIds`). |
| `timeline`, `room_info`, `read_markers` | Matrix connector store, `src/matrix/social.ts` | A mirror of the Matrix rooms the agent account sees | Matrix only. Unordered `documents` scans. Not used by other channels. |
| Synapse | homeserver | The history the web console actually shows | Not Router's data. No view of Feishu, mail or other channels. |

Owner DMs on every channel already share one conversation (and therefore one execution session):
`c-` + `digest(key(agentId, "owner-main"))` (`core.ts:122`). The web console cannot show that merged
conversation because it only reads Matrix. Run cards, approvals (`communication/runs/:claimId`, Mau's
`mau-approval:` synthetic calls through `BusinessHost`) and the task list (`communication/tasks`) are
attached to chat bubbles by matching Matrix event ids. A message that entered through Feishu has no
Matrix id, so it cannot carry a run card in the console.

Product direction (agreed with the product owner):

1. Router becomes the single source of truth, with one ledger, one identity model and one delivery service.
2. The web console talks to Router/Mau directly.
3. Matrix becomes one more channel adapter. Synapse keeps running for now and can be removed later.
4. The design must map onto Cloudflare Durable Objects later: one DO per agent with SQLite, alarms and
   hibernating WebSockets.

Prior art was verified in source. **OpenClaw** has per-agent conversation, session, transcript and
delivery tables, durable ingress claims with tombstones, a `req`/`res`/`event` web protocol, per-session
`seq`, and history paging with delta/reset catch-up. **Hermes** has a replay epoch with
`snapshot_required`, a rule that never auto-replays unknown started inputs, a visible "may be duplicate"
marker, pairing codes, and cron that runs either in a fresh session or in a target session. Neither
covers Mau's needs for several owners with several agents each, owner approval cards, the run process
view, owner-only groups with mention routing, or cross-channel person identity.

## 2. Decision

1. **Every agent has a ledger** inside its existing per-agent SQLite file (`state/agents/<agentId>.sqlite`).
   It uses real tables with a `ledger_` prefix, next to the existing `documents` table. Because it is the
   same file, ingress claims, legacy inbox records and `CliWork` submission can share one transaction. The
   ledger records conversations (routing endpoints), sessions and their windows, transcript events with a
   gapless per-session `seq`, pending inputs, turns, cards, deliveries and the platform-message index.
2. **Every owner has a hub** (`state/owners/<ownerKey>.sqlite`). It holds the owner's chat index, read
   markers, **group rooms and their transcripts**, room-to-agent fan-out, and WebSocket fan-out. Groups
   contain only the owner and the owner's own agents, so they belong to the owner and not to any one agent.
3. **The global registry** (the existing `registry.sqlite`) gains persons and person identities (web login,
   Matrix id, Feishu open_id, mail address). These are kept separate from routing aliases, which say which
   agent an address reaches.
4. **One write path for every channel:** ingress, then claim, then transcript event, then pending input,
   then turn, then events, then delivery. Web is one channel adapter. Matrix is another. Web needs no
   delivery row because the transcript is its delivery.
5. **Transcript first, then deliver.** An assistant message is recorded once and then delivered to its
   origin conversation. Delivery status is a separate, visible fact. Streaming partials are never
   persisted. A client restores in-flight text from the Host run (already cached in
   `communication_run_events`).
6. **Session keys stay compatible:** `session_key` equals today's `conversationId` (`c-…`, `w-…`). Window 1
   of each session uses that key as its execution `contextId`, so `execution_sessions`,
   `communication_runs` and Host sessions need no rewrite. A reset opens window *n* with `contextId =
   <key>.w<n>`.
7. **Web API:** HTTP for every command and every history read, plus one WebSocket per tab for events.
   Frames are `req`/`res`/`event`. `chat.send` requires an `idempotencyKey`. Durable events carry
   `(chatId, generation, seq)`. Clients catch up by seq gap through history `after=`. A changed generation
   or an oversized gap gives `reset`/`snapshot_required`.
8. **Login keeps using Synapse whoami for now**, behind an `OwnerAuthenticator` interface. Native login
   comes in a later phase.
9. **Migration ships in phases.** Phase 1 shadow-writes the ledger and backfills the about 922 existing
   events. After that, the web console switches one feature at a time (history, then send, then cards,
   then attachments, then groups) behind flags. The old records are dual-written until each consumer has
   moved.

## 3. Vocabulary

| Term | Meaning |
| --- | --- |
| Person | A human (`prs_…`). An owner is a person who owns agents. Today `ownerId` = the owner's Matrix id. It becomes `person_id` in phase 6. |
| Identity | A verified `(provider, namespace, subject)` of a person, such as `("feishu", appId, open_id)`. Identities decide who is speaking. |
| Routing alias | An address that reaches an agent (`owner/name@server`, mail inbox, Feishu bot app). Aliases decide which agent receives a message. They are never used to identify a person. |
| Connection | An existing `ConnectionDefinition` plus its adapter (`matrix`, `feishu-…`, `web`, `room`). |
| Conversation | One routing endpoint on one connection: a DM, a group, or a group thread. It holds the reply route. |
| Session (key) | The agent's logical dialogue, with one execution context per window. Several conversations can feed one session (owner-main). |
| Window | One execution context of a session. A reset opens a new window under the same key. |
| Chat | What the web console lists. A `dm` chat is the owner-main session of one agent. A `group` chat is a hub room. An `observed` chat is another session of an agent, read-only. |
| Turn | One execution of an agent. `turnId` = `CliWork` task id. A turn has zero or more Host runs (claims). |
| Event | One durable transcript entry. It has an `eventId` (`ev_<ulid>`) and a `seq` inside its session or room. |
| Delivery | One attempt to put an event on an external channel, with a platform message id once accepted. |

## 4. Schema

All timestamps are integer milliseconds. All `body`/`route` columns hold JSON. Each `CREATE TABLE`
runs in a migration guarded by a `meta` row (`ledger_schema_version`). `DurableStore` stays as it is and
gains `migrate(version, sql)`.

### 4.1 Per-agent ledger (in `state/agents/<agentId>.sqlite`)

```sql
-- Routing endpoints. Uniqueness follows OpenClaw.
CREATE TABLE ledger_conversations(
  conversation_id TEXT PRIMARY KEY,          -- "cv_" + digest(channel,account_id,kind,peer_id,parent_id,thread_id)
  connection_id   TEXT NOT NULL,             -- existing connection id, "web" or "room"
  channel         TEXT NOT NULL,             -- matrix|feishu|grove-mail|telegram|weixin|web|room
  account_id      TEXT NOT NULL,             -- the identity bound by bindAccount (bot app, agent mxid, ownerKey for web)
  kind            TEXT NOT NULL CHECK(kind IN ('direct','group','channel')),
  peer_id         TEXT NOT NULL,             -- see section 5
  parent_id       TEXT NOT NULL DEFAULT '',
  thread_id       TEXT NOT NULL DEFAULT '',
  session_key     TEXT NOT NULL,
  person_id       TEXT,                      -- resolved peer person for direct conversations
  reply_route     TEXT NOT NULL,             -- latest ReplyRoute. Each turn freezes its own copy.
  title           TEXT,
  created_at INTEGER NOT NULL, last_inbound_at INTEGER,
  UNIQUE(channel, account_id, kind, peer_id, parent_id, thread_id)
);
CREATE INDEX ledger_conversations_session ON ledger_conversations(session_key);

CREATE TABLE ledger_sessions(
  session_key TEXT PRIMARY KEY,              -- legacy conversationId: "c-…" / "w-…"
  kind        TEXT NOT NULL CHECK(kind IN ('owner_main','peer','group','room','schedule','work','delegation')),
  label       TEXT NOT NULL,                 -- readable: "owner-main", "room:rm_…", "feishu:group:oc_…"
  room_id     TEXT,                          -- kind='room'
  window      INTEGER NOT NULL DEFAULT 1,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  generation  INTEGER NOT NULL DEFAULT 1,    -- bumped when history is rewritten (backfill, purge)
  published_seq INTEGER NOT NULL DEFAULT 0,  -- the hub has acknowledged events up to here
  title TEXT, archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE ledger_session_windows(
  session_key TEXT NOT NULL, window INTEGER NOT NULL,
  context_id  TEXT NOT NULL UNIQUE,          -- window 1 = session_key, then "<key>.w<n>"
  opened_at INTEGER NOT NULL, closed_at INTEGER, reason TEXT,   -- 'reset'|'migration'|'archive'
  PRIMARY KEY(session_key, window)
);

CREATE TABLE ledger_session_conversations(
  session_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('primary','participant','related')),
  last_inbound_at INTEGER,
  PRIMARY KEY(session_key, conversation_id)
);

-- The transcript. seq is gapless per session_key and assigned inside the write transaction.
CREATE TABLE ledger_events(
  session_key TEXT NOT NULL, seq INTEGER NOT NULL,
  event_id    TEXT NOT NULL UNIQUE,          -- "ev_<ulid>"
  window      INTEGER NOT NULL,
  kind        TEXT NOT NULL,                 -- see section 8.3
  role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  sender_type TEXT NOT NULL CHECK(sender_type IN ('person','agent','external','system')),
  sender_id   TEXT NOT NULL,                 -- person id, agent id, or channel subject for unknown senders
  conversation_id TEXT,                      -- the conversation the event entered or left through
  turn_id     TEXT,
  ref_event_id TEXT,                         -- target of edit/redaction/reaction/card.update/delivery/replyTo
  idempotency_key TEXT,                      -- "web:<personId>:<key>", "<connectionId>:<externalId>", "turn:<id>:final" …
  created_at  INTEGER NOT NULL,
  body        TEXT NOT NULL,                 -- at most 256 KiB. Larger text becomes an attachment.
  PRIMARY KEY(session_key, seq),
  UNIQUE(session_key, idempotency_key)
);
CREATE INDEX ledger_events_turn ON ledger_events(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX ledger_events_ref  ON ledger_events(ref_event_id) WHERE ref_event_id IS NOT NULL;

-- Durable ingress claims. Acknowledge only after commit. The tombstone keeps the hash, not the body.
CREATE TABLE ledger_ingress(
  connection_id TEXT NOT NULL, external_id TEXT NOT NULL,
  input_id    TEXT NOT NULL UNIQUE,          -- = legacy inbox id digest(key(agentId, connectionId, externalId))
  hash        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK(state IN ('accepted','ignored','tombstone')),
  reason      TEXT, event_id TEXT, conversation_id TEXT,
  received_at INTEGER NOT NULL, expires_at INTEGER,   -- tombstones are deleted after 30 days
  PRIMARY KEY(connection_id, external_id)
);

-- Inputs that have been accepted but not yet consumed by a turn.
CREATE TABLE ledger_pending_inputs(
  input_id    TEXT PRIMARY KEY,
  session_key TEXT NOT NULL, event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','starting','started','control','dropped','unknown')),
  turn_id TEXT, retry_of TEXT, reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ledger_pending_due ON ledger_pending_inputs(state, created_at) WHERE state IN ('queued','starting');

CREATE TABLE ledger_turns(
  turn_id     TEXT PRIMARY KEY,              -- CliWork task id
  session_key TEXT NOT NULL, window INTEGER NOT NULL,
  admission   TEXT NOT NULL CHECK(admission IN ('owner','peer','group','schedule','work','delegation')),
  origin_conversation_id TEXT, origin_event_id TEXT,
  reply_route TEXT,                          -- frozen at turn start. NULL means web/hub only.
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','completed','failed','canceled','unknown')),
  final_event_id TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX ledger_turns_session ON ledger_turns(session_key, created_at);
-- turn → Host runs remains communication_runs (RunBinding.taskId = turn_id, keyed by claimId).

CREATE TABLE ledger_cards(
  card_id   TEXT PRIMARY KEY,                -- "cd_" + digest(runId, callId)
  call_id   TEXT NOT NULL,                   -- Host call id, or "mau-approval:<callId>"
  run_id TEXT NOT NULL, claim_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  session_key TEXT NOT NULL, event_id TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK(kind IN ('question','approval','connector_approval','sensitive')),
  status TEXT NOT NULL CHECK(status IN ('pending','answered','approved','rejected','expired','canceled')),
  deadline_at INTEGER, answered_by TEXT, answer_key TEXT UNIQUE, result TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ledger_cards_open ON ledger_cards(session_key) WHERE status = 'pending';
CREATE TABLE ledger_card_tokens(token TEXT PRIMARY KEY, card_id TEXT NOT NULL, choice_id TEXT NOT NULL, result TEXT NOT NULL);

CREATE TABLE ledger_deliveries(
  delivery_id TEXT PRIMARY KEY,              -- = adapter send key. Legacy outbox ids are reused unchanged.
  event_id TEXT,                             -- NULL only for purpose='activity'
  conversation_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  route   TEXT NOT NULL,                     -- frozen ReplyRoute
  purpose TEXT NOT NULL CHECK(purpose IN ('reply','notice','card','content','activity','mirror')),
  status  TEXT NOT NULL CHECK(status IN ('created','queued','sending','sent','suppressed','rejected','unknown','replied')),
  content TEXT,                              -- ChannelContent when not plain text
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
  platform_message_id TEXT, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ledger_deliveries_due ON ledger_deliveries(next_at) WHERE status = 'queued';
CREATE INDEX ledger_deliveries_event ON ledger_deliveries(event_id);

-- Platform id → event, for both directions. Used for quotes, reactions, edits, card replies and the run view.
CREATE TABLE ledger_platform_messages(
  connection_id TEXT NOT NULL, platform_message_id TEXT NOT NULL,
  event_id TEXT NOT NULL, part INTEGER NOT NULL DEFAULT 0,   -- one row per chunk
  PRIMARY KEY(connection_id, platform_message_id)
);
CREATE INDEX ledger_platform_by_event ON ledger_platform_messages(event_id);

CREATE TABLE ledger_attachments(
  attachment_id TEXT PRIMARY KEY,            -- "at_<ulid>"
  event_id TEXT, name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER,
  sha256 TEXT,                               -- set once the bytes are in the blob store
  locator TEXT NOT NULL,                     -- {"blob":"sha256:<hex>"} or {"channel":<AttachmentReference>} (read lazily)
  created_at INTEGER NOT NULL
);
```

Delivery status mapping from today's `OutboxRecord.state`: `queued→queued`, `submitting→sending`,
`accepted→sent`, `failed→rejected`, `uncertain→unknown`. `suppressed` means the delivery was
intentionally not sent: a stale activity, a disabled mirror, or an owner-only notice on a peer channel.
`replied` means the peer quoted or answered this platform message.

### 4.2 Owner hub (`state/owners/<ownerKey>.sqlite`, `ownerKey = digest(ownerId)`)

```sql
CREATE TABLE hub_chats(
  chat_id   TEXT PRIMARY KEY,                -- "dm:<agentId>" | "room:<roomId>" | "obs:<agentId>:<sessionKey>"
  kind      TEXT NOT NULL CHECK(kind IN ('dm','group','observed')),
  agent_id  TEXT, session_key TEXT, room_id TEXT,
  title TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1,
  last_event TEXT,                           -- {eventId, at, preview(≤140 chars), sender}
  active_turns INTEGER NOT NULL DEFAULT 0, pending_cards INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX hub_chats_recent ON hub_chats(archived, updated_at DESC);

CREATE TABLE hub_read_markers(chat_id TEXT NOT NULL, person_id TEXT NOT NULL, read_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, person_id));

CREATE TABLE hub_rooms(
  room_id TEXT PRIMARY KEY,                  -- "rm_<ulid>"
  title TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  matrix_room_id TEXT UNIQUE,                -- set for imported ai.mau.room groups
  last_seq INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE hub_room_members(
  room_id TEXT NOT NULL, member_type TEXT NOT NULL CHECK(member_type IN ('person','agent')), member_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','agent')), joined_at INTEGER NOT NULL, left_at INTEGER,
  PRIMARY KEY(room_id, member_type, member_id)
);
-- The canonical group transcript. Same columns as ledger_events, keyed by room.
CREATE TABLE hub_room_events(
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, role TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT NOT NULL,
  turn_id TEXT, ref_event_id TEXT, idempotency_key TEXT, created_at INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(room_id, seq), UNIQUE(room_id, idempotency_key)
);
-- Room → agent ingress. At-least-once. The agent dedupes on (connection 'room', external_id).
CREATE TABLE hub_fanout(
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(room_id, seq, agent_id)
);
-- Idempotent HTTP commands other than chat.send: group create, reset, card answer, membership.
CREATE TABLE hub_commands(person_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(person_id, idempotency_key));
CREATE TABLE hub_pairing_codes(code_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER, consumed_identity TEXT);
CREATE TABLE hub_blobs(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL);   -- bytes live in state/blobs/sha256/<aa>/<hex>
```

`hub_chats` for `dm`/`observed` chats is an index. Its `last_seq` mirrors the agent session's `last_seq`
as far as the hub has seen. The events themselves stay in the agent ledger.

### 4.3 Global registry (`state/registry.sqlite`)

```sql
CREATE TABLE reg_persons(person_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE reg_person_identities(
  identity_id TEXT PRIMARY KEY, person_id TEXT NOT NULL,
  provider  TEXT NOT NULL,   -- matrix|web|oidc|feishu|grove-mail|agentmail|telegram|weixin
  namespace TEXT NOT NULL,   -- homeserver | issuer | Feishu app_id (open_id is per app) | '' for mail
  subject   TEXT NOT NULL,   -- mxid | sub | open_id | lowercased address | user id
  verified_by TEXT NOT NULL CHECK(verified_by IN ('login','config','pairing','admin')),
  created_at INTEGER NOT NULL, revoked_at INTEGER,
  UNIQUE(provider, namespace, subject)
);
CREATE INDEX reg_identities_person ON reg_person_identities(person_id);
-- The existing matrix_agents documents gain owner_person_id. Routing aliases (directory address, channel
-- connection → agent) stay in their existing documents and are never consulted for person identity.
```

`ConnectionDefinition.ownerAddresses` becomes a derived view: the identities of the owner person
that match the connection's provider and namespace. Phase 1 seeds identities from today's configured
`ownerAddresses` with `verified_by='config'`.

## 5. Keying rules

`legacy(x)` = `c-` + `digest(key(agentId, x)).slice(0,40)`, which is today's formula (`core.ts:122-123`).
"Owner" means the sender resolves to an identity of the agent's owner person.

| Source | kind | peer_id | parent_id | thread_id | session_key | session kind |
| --- | --- | --- | --- | --- | --- | --- |
| Web DM (owner ↔ agent) | direct | `person:<personId>` | '' | '' | `legacy("owner-main")` | owner_main |
| Web group room | group | `room:<roomId>` | '' | '' | `legacy(key("room", roomId))` | room |
| Matrix DM, owner | direct | sender mxid | room id | '' | `legacy("owner-main")` | owner_main |
| Matrix DM, other | direct | sender mxid | room id | '' | `legacy(key("matrix","direct",roomId,sender))` | peer |
| Matrix group (not imported) | group | room id | '' | `m.thread` root or '' | `legacy(key("matrix","group",threadId,"group"))` | group |
| Feishu DM, owner | direct | open_id | chat_id | '' | `legacy("owner-main")` | owner_main |
| Feishu DM, other | direct | open_id | chat_id | '' | legacy formula for that peer | peer |
| Feishu group | group | chat_id | '' | '' | legacy formula for the group | group |
| Feishu reply chain / topic thread | group | chat_id | '' | `root_id \|\| thread_id` | legacy formula with `threadId=<chat>:<root>` (as `feishu.ts` emits today) | group |
| Feishu doc comment | group | `document:<fileToken>` | '' | commentId | legacy formula with `threadId=comment:<file>:<comment>` | group |
| Mail (owner) | direct | address | '' | provider `thread_id` (else first message id) | `legacy("owner-main")` | owner_main |
| Mail (other) | direct | address | '' | provider `thread_id` (else first message id) | legacy formula per (address, thread) | peer |
| Schedule, fresh | — | — | — | — | Mau's `w-…` session id per run | schedule |
| Schedule, target session | — | — | — | — | the target session's key (usually owner-main) | (unchanged) |
| Owner work API (`work-events`) | — | — | — | — | the submitted `sessionId` or `w-…` | work |
| A2A delegation | direct | peer agent mxid | room id | contextId | legacy formula | delegation |

Rules:

- Today's `threadId` already encodes the Feishu, mail and Matrix threading, and the legacy formula
  is reused for each class. As a result, every existing `execution_sessions` and `communication_runs`
  row resolves to the same session after migration.
- Every owner DM on every channel is a separate conversation in one `owner_main` session. The first web
  DM conversation is that session's `primary`. The others are `participant`.
- A reply goes to the turn's frozen `reply_route` (its origin conversation). It is never sent to "the
  latest chat".
- A conversation never moves to another session. To change a session, open a new window.
- A message from an unknown sender is not written to any transcript. Its claim is `ignored` with a
  reason, or it follows the existing visitor/decision flow.

## 6. Write paths

### 6.1 Ingress (one SQLite transaction, before the adapter advances its cursor)

`ChannelContext.receive(message)` keeps its signature. `CommunicationCore.receive` becomes:

1. Validate with `messageSchema`. Compute `input_id` (unchanged formula) and the hash.
2. **Claim** `(connection_id, external_id)` in `ledger_ingress`. If the claim exists with the same hash,
   return it (duplicate). If the hash differs, throw `channel_event_id_reused_with_different_payload`, as today.
3. Resolve the sender person through `reg_person_identities`. Upsert the conversation and its session
   (section 5) and the `session_conversations` row.
4. Run authorization exactly as today (`allowed`, `addressed`, oversize). If the message is not allowed or
   is empty, set the claim to `ignored` and stop. A notice for an oversized input is still queued, as a
   `notice` event plus a delivery.
5. Append a transcript event, using `idempotency_key = <connectionId>:<externalId>`:
   - message, attachments or quote → `kind:"message"`
   - reaction, edit or redaction → the matching kind, with `ref_event_id` resolved through `ledger_platform_messages`
   - button action → `kind:"action"` (system-visible, rendered as "选择了 X")
6. Insert `ledger_platform_messages(connection, externalId → event)`.
7. If the input is actionable (not a reaction/edit/redaction), insert a `ledger_pending_inputs` row with state `queued`.
8. Dual-write the legacy `communication_inbox` record (phases 1–3 only).
9. Commit and return. The adapter acknowledges the provider and advances its cursor.

The hub learns about new events through publication (section 6.6), never inside this transaction.

### 6.2 Dispatch (pending input → turn)

The dispatcher reads `ledger_pending_due` in order. It does not scan every inbox document.

1. **Control first.** Card answers by text or button, `/cancel`, `/steer`, `/link <code>` and stale
   actions are handled as today (`HostWorker.handleInput`). The input's state becomes `control`, and any
   notice becomes a `notice` event.
2. Otherwise set the state to `starting` (commit), then call `work.send` with the stable message id
   `channel-<input_id>`, as today. After a crash the same id is sent again, and `CliWork` returns the
   same task. Then commit, in one transaction: state `started`, the `turn_id`, a `ledger_turns` row (or
   reuse it on resume), and a `turn` event with state `queued`.
3. The text sent to the model is assembled as it is today: quote, text, event JSON, attachment list, and
   the 24 KB cap. Room turns also get group context (section 6.5).
4. **Unknown work is never replayed automatically.** When a run binding becomes `unknown` (the Host lost
   it, or `closeUnknown`), the turn becomes `unknown`. The ledger then appends a `turn` event with
   `state:"unknown"` and a card of kind `question` with the choices "重新执行" and "不用了". Choosing
   retry creates a new pending input with `retry_of`. Its event carries `possibleDuplicate: true`, which
   the console shows as "可能重复执行".

### 6.3 Turn and run events

`HostWorker` observation already tracks run phases, interactions and progress text. It now also writes:

| Host fact | Ledger write (one transaction) | Published |
| --- | --- | --- |
| Binding becomes `running` | turn `running`, `turn` event | durable |
| Interaction presented (`present`) | `ledger_cards` row, `card` event, button tokens. A `card` delivery is created only if the origin is not web. | durable |
| Interaction resolved from any surface | card status, `card.update` event, `notice` "已收到回答" | durable |
| Progress text (`progress`) | nothing (not persisted) | `chat.stream` |
| Terminal (`publishResults`) | assistant `message` event (`final:true`, `turn_id`, idempotency `turn:<id>:final`), turn finished, `reply` delivery to the frozen route unless it is web/room-native, legacy outbox dual-write | durable |
| Non-terminal status message | `notice` event plus delivery | durable |

Connector approvals (`mau-approval:` calls synthesized by Mau's `BusinessHost.calls`) are presented
through the same path, with `kind:'connector_approval'`. Answers still go to
`RunObservation.resolve(claimId, callId, result)`, so Mau keeps the authority key and Router only
renders the card. The first answer from any surface wins. A later answer gets `stale`.

### 6.4 Delivery

`CommunicationCore.flush` reads `ledger_deliveries_due` in place of `communication_outbox`. The rest
does not change: adapter `send`/`sendContent`/`progress`/`activity`, the chunk checkpoints keyed by the
send key (`send:<deliveryId>:<n>`), `ChannelSendError` dispositions, and backoff. When a delivery
reaches `sent`, `unknown` or `rejected`, a `delivery` event is appended (`ref_event_id` = the delivered
event) and the platform ids are indexed. Activity reactions have no event. The rule is "record, then
deliver": the console shows the reply immediately and shows delivery state as a badge. This differs
from Hermes' "deliver then record" because the ledger, not the channel, is the record.

### 6.5 Groups (hub rooms)

1. `POST …/messages` on a room chat runs one hub transaction: idempotency check, `hub_room_events` append
   (seq), and `hub_fanout` rows for each addressed agent. An agent is addressed if it is in
   `mentions.agentIds ∩ member agents`, or if `mentions.all` is set (then every member agent is).
   **Only the owner's messages fan out.** An agent's message never triggers another agent, as today.
2. The fan-out worker calls each agent's ingress through the `RoomChannel` adapter
   (`connection_id:"room"`, `external_id:"<roomId>:<seq>"`, `scope:"group"`,
   `mentions:{self:true,all}`, `privateGroup:true`). It is retry-safe because of the claim.
3. In the agent ledger the room is a `room` session. Its transcript holds only the agent's own inputs,
   outputs, cards and turns. Room history is not copied. At turn start, `RoomChannel` supplies the
   unaddressed room messages since the agent's previous turn (cap: 30 messages / 8 KB), prefixed
   "群聊上下文：".
4. The agent's reply goes through `RoomChannel.send(route, text, deliveryId)`, which calls the hub's
   `appendRoomEvent(idempotencyKey = deliveryId, replyTo = origin event)`. The returned `event_id` is the
   platform message id. `retrySafe = true`. Cards for room turns are mirrored into the room as `card`
   events with the same `cardId`, and answers route back to the owning agent.

### 6.6 Publication (agent ledger → hub → sockets)

Each agent session has a `published_seq`. After each commit the ledger signals the hub. In Node this is
an in-process call. In a DO it is an RPC to the owner hub DO. The hub reads events after
`published_seq`, updates `hub_chats` (`last_seq`, preview, counters), pushes `chat.event` frames to
subscribed sockets, and acknowledges, which advances `published_seq`. Delivery is at-least-once. Sockets
dedupe by `(chatId, seq)`. `chat.stream` deltas use the same signal path but are never stored or
acknowledged.

### 6.7 Schedules and owner work

Mau's proactive rules already choose either a fresh `w-…` session or a target session (idle only). The
run is recorded as a turn with `admission:'schedule'`, and the input is recorded as a `system` event
(`kind:"message"`, `role:"user"`, `sender_type:"system"`, `body.origin:"schedule"`). A notice that Mau
decides to deliver (`ProactivePort.deliver`) is appended to the target session as an assistant `notice`
with idempotency `schedule:<eventId>`. It reaches the web through the DM chat. A channel delivery is
added only for the session's configured push conversation (open question 2). Fresh schedule sessions
appear as `observed` chats.

### 6.8 Session reset

`POST …/reset` closes the current window, opens window *n+1* with `context_id = <key>.w<n+1>`, and
appends a `window` event. New turns start a new Host session. `seq` continues, so a chat stays one
scrollable history with a divider. Reset of `owner_main` affects every owner channel, because they
share the session.

## 7. Existing records: migrate or deprecate

| Existing | Fate | When removed |
| --- | --- | --- |
| `communication_inbox` | Dual-written from ingress. The dispatcher switches to `ledger_pending_inputs` in phase 3. `RunObservation.tasks`, `isOwnerTask` and `input(taskId)` switch to `ledger_turns`/`ledger_events`. | After phase 4, plus one release |
| `communication_outbox` | `flush` switches to `ledger_deliveries` in phase 3. Ids are kept, so chunk checkpoints stay valid. | After phase 3, plus one release |
| `communication_questions`, `_actions`, `_control_receipts` | Become `ledger_cards`/`ledger_card_tokens`. Control receipts keep their `input_id` key. | Phase 4 |
| `communication_results`, `_streams`, `_progress_messages` | Results become the final event body. Stream and progress ids go to `ledger_platform_messages`. | Phase 4 |
| `communication_threads` | Become `ledger_conversations`. | Phase 3 |
| `communication_runs`, `communication_run_archives`, `execution_sessions` | **Kept as they are**, joined by `turn_id`/`session_key`. | Never (execution records) |
| `communication/tasks` API (`replyMessageIds`, `interactionMessageIds`) | Gains `turnId`, `inputEventIds`, `finalEventId`, `cardIds`, and is deprecated in favor of `GET /web/chats/:chatId/turns/:turnId`. | When the console stops calling it |
| Matrix `timeline`, `room_info`, `read_markers` (agent side) | Read only by the Matrix CLI/social API. The console stops using them after phase 2. | With Synapse |
| Mau `memory_history` (FTS) | Stays a derived search index. It can later be fed from ledger final events in place of completed-turn hooks. | Not in scope |
| `src/channels/router.ts` visitor ledger | Untouched (open question 9). | — |

## 8. Web channel API

### 8.1 Conventions

- Base path: `/_agent-router/v1/web`. Every route is owner-scoped. Agent ids appear only inside chat ids
  and bodies.
- Authentication: `Authorization: Bearer <Matrix access token>`, verified by
  `OwnerAuthenticator.authenticate(token) → { personId, ownerId, matrixUserId }`. The current
  implementation is `SynapseWhoamiAuthenticator`, which wraps `service.authenticate`, caches the result
  by token hash for 60 s, and never stores tokens. Phase 6 adds a native implementation.
- Errors use the existing shape: `{ "error": "snake_code", "retryAfterMs"?: number }` with HTTP
  400/401/403/404/409/413/422/429/503.
- Ids are opaque strings. Clients must URL-encode `chatId`, because it contains `:`.
- Times are ISO-8601 strings in responses.
- Caps:
  - text: 24 KB UTF-8 per send, 256 KiB per stored event
  - history page: `limit ≤ 200` and 1 MiB per response
  - attachments: 25 MiB per file, 10 per message, 30 MiB per message
  - sockets: 10 per person
  - rate: the existing 1200 requests/min/IP

### 8.2 Shared types

```ts
type Actor = { type: "person" | "agent" | "system" | "external"; id: string; name: string };
type ChannelTag = { kind: "web" | "room" | "matrix" | "feishu" | "grove-mail" | "agentmail" | "telegram" | "weixin" | "schedule"; label?: string };
type AttachmentRef = { attachmentId: string; name: string; contentType: string; size: number | null; sha256: string | null;
  url: string /* "/_agent-router/v1/web/attachments/<id>" */ };
type DeliveryState = { deliveryId: string; channel: ChannelTag; status: "queued" | "sending" | "sent" | "suppressed" | "rejected" | "unknown" | "replied"; error?: string };
type CardStatus = "pending" | "answered" | "approved" | "rejected" | "expired" | "canceled";
interface Card {
  cardId: string; agentId: string; turnId: string; claimId: string; callId: string;
  kind: "question" | "approval" | "connector_approval" | "sensitive";
  text: string;                                  // the same text interaction() produces today
  choices: Array<{ choiceId: string; label: string; style?: "primary" | "danger" }>;
  freeText: boolean;                             // a text answer is accepted
  native?: { method: string; params: unknown };  // for @olorinm/agent-host/interactions describeInteraction
  deadlineAt: string | null; status: CardStatus;
}

type ChatEvent = {
  chatId: string; seq: number; generation: number; eventId: string; at: string;
  sender: Actor; channel?: ChannelTag; turnId?: string; idempotencyKey?: string /* only on the sender's own web messages */;
} & (
  | { kind: "message"; role: "user" | "assistant"; text: string; html?: string; attachments?: AttachmentRef[];
      mentions?: { agentIds: string[]; all: boolean }; replyTo?: string; final?: boolean; possibleDuplicate?: boolean;
      deliveries?: DeliveryState[] /* current state, history responses only */ }
  | { kind: "notice"; text: string; level: "info" | "warning" }
  | { kind: "action"; targetCardId: string; label: string }
  | { kind: "card"; card: Card /* status is current in history responses, as of creation on the socket */ }
  | { kind: "card.update"; cardId: string; status: CardStatus; answeredBy?: Actor; summary?: string }
  | { kind: "turn"; agentId: string; state: "queued" | "running" | "waiting" | "completed" | "failed" | "canceled" | "unknown";
      inputEventIds: string[]; error?: string }
  | { kind: "delivery"; targetEventId: string; delivery: DeliveryState }
  | { kind: "edit"; targetEventId: string; text: string }
  | { kind: "redaction"; targetEventId: string }
  | { kind: "reaction"; targetEventId: string; key: string; removed: boolean }
  | { kind: "window"; window: number; reason: "reset" | "migration" }
  | { kind: "member"; action: "add" | "remove" | "rename"; member?: Actor; title?: string }
);

interface ChatSummary {
  chatId: string; kind: "dm" | "group" | "observed"; title: string; agentIds: string[];
  readOnly: boolean; lastSeq: number; generation: number; readSeq: number; unread: number;
  lastEvent: { eventId: string; at: string; preview: string; sender: Actor } | null;
  activeTurns: number; pendingCards: number; updatedAt: string;
}
interface Inflight { turnId: string; agentId: string; text: string; updatedAt: string; afterSeq: number }
```

Folding rules for clients:
- `edit`, `redaction`, `reaction`, `card.update` and `delivery` modify their target, and are not rendered
  as their own bubbles.
- A `turn` event with state `queued`/`running`/`waiting` shows activity. A terminal state clears the
  turn's in-flight text.
- `unread` counts only `message` and `card` events with `seq > readSeq` that were not sent by the reader.

### 8.3 Endpoints

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /me` | — | `{ person:{id,name}, ownerId, identities: Identity[], limits }` |
| `POST /socket-tickets` | `{}` | `{ ticket, expiresAt }` (single use, 60 s) |
| `GET /chats?archived=false&cursor=` | — | `{ data: ChatSummary[], next: string \| null }`, newest first |
| `POST /chats/dm` | `{ agentId }` | `ChatSummary`. Idempotent: one DM chat per agent. |
| `GET /chats/:chatId` | — | `ChatSummary & { members: Actor[] }` |
| `GET /chats/:chatId/events` | query below | `EventPage` |
| `POST /chats/:chatId/messages` | `SendRequest` | `SendResponse` |
| `POST /chats/:chatId/reset` | `{ idempotencyKey }` | `{ window, event: ChatEvent }` |
| `POST /chats/:chatId/read` | `{ seq }` | `{ readSeq, unread }`. Monotonic: a lower seq is ignored. |
| `GET /chats/:chatId/turns/:turnId` | — | `TurnDetail` |
| `POST /chats/:chatId/turns/:turnId/cancel` | `{}` | `{ status:"accepted" }` |
| `POST /chats/:chatId/turns/:turnId/steer` | `{ idempotencyKey, text }` | `{ status:"accepted" \| "unsupported" }` |
| `POST /chats/:chatId/cards/:cardId/answer` | `AnswerRequest` | `{ status:"accepted" \| "duplicate" \| "stale", card: Card }` |
| `POST /attachments` | raw body | `AttachmentRef` |
| `GET /attachments/:attachmentId` | — | bytes |
| `POST /groups` | `{ idempotencyKey, title, agentIds }` | `ChatSummary` |
| `PATCH /groups/:roomId` | `{ title?, archived? }` | `ChatSummary` |
| `POST /groups/:roomId/members` | `{ agentId }` | `{ members: Actor[] }` |
| `DELETE /groups/:roomId/members/:agentId` | — | `{ members: Actor[] }` |
| `POST /identities/pairing-codes` | `{}` | `{ code, expiresAt }` |
| `DELETE /identities/:identityId` | — | 204 |

Existing endpoints stay and are linked from `TurnDetail`:
- `GET /agents/:agentId/communication/runs/:claimId`
- `/runs/:claimId/events?after=&limit=`
- `/runs/:claimId/calls/:callId/result`

**History** `GET /chats/:chatId/events`:

- No cursor: returns the latest page, `limit` default 50.
- `before=<seq>`: returns older events. `after=<seq>&generation=<g>`: catch-up.
- `limit` is between 1 and 200.

```ts
interface EventPage {
  chatId: string; generation: number; lastSeq: number;
  mode: "page" | "delta" | "reset";       // reset: discard local state, then load the latest page
  reset?: { reason: "generation_changed" | "gap_too_large" | "not_found" };
  events: ChatEvent[];                    // ascending seq, contiguous
  olderCursor: number | null;             // pass as before= ; null at the beginning
  newerCursor: number | null;             // pass as after= ; null when caught up
  inflight: Inflight[];                   // only on latest pages and on delta pages that are caught up
}
```

`mode:"reset"` is returned in these cases:
- `generation` differs from the chat's current generation;
- `lastSeq - after > 1000`;
- the 1 MiB budget cannot reach the end and the client asked with `strict=true`.

Otherwise a delta page has `newerCursor` set, and the client keeps paging.

**Send** `POST /chats/:chatId/messages`:

```ts
interface SendRequest {
  idempotencyKey: string;                 // 16–128 chars [A-Za-z0-9_-], one per user intent (UUID/ULID)
  text: string;                           // may be "" if attachments are present
  attachments?: string[];                 // attachmentIds from POST /attachments
  mentions?: { agentIds: string[]; all?: boolean };   // groups only. Validated against members.
  replyTo?: string;                       // eventId in the same chat
}
interface SendResponse {
  status: "accepted" | "duplicate";       // duplicate: same key and same body. The original event is returned.
  event: ChatEvent;                       // the stored user message, with its seq
  addressed: Array<{ agentId: string; state: "queued" | "control" | "not_addressed" }>;
}
```

Error codes:

| Status | Codes |
| --- | --- |
| 409 | `idempotency_key_reused` (same key, different body) |
| 413 | `message_too_large` |
| 403 | `chat_read_only` |
| 422 | `mention_not_member`, `attachment_not_found`, `message_empty` |

Clients render an optimistic bubble keyed by `idempotencyKey`. They replace it with the response event
or with the matching socket event, whichever comes first. On a network failure the client retries with
the same key. In a DM chat the message enters the owner-main session through the `web` conversation. In
a group it goes through the hub fan-out (section 6.5).

**Turn detail:**

```ts
interface TurnDetail {
  turnId: string; chatId: string; agentId: string; state: string; admission: string;
  inputEventIds: string[]; finalEventId: string | null; cardIds: string[];
  runs: Array<{ claimId: string; runId: string | null; phase: "submitting" | "running" | "finished" | "unknown"; error: string | null }>;
}
```

The run surface (`mau/web/src/screens/run-surface.tsx`, `RunReader`) is unchanged except for its keys.
A bubble finds its turn through `event.turnId`, and the turn's runs come from `TurnDetail.runs`. Matrix
event ids are no longer involved.

**Card answer:**

```ts
type AnswerRequest = { idempotencyKey: string } & ({ choiceId: string } | { text: string } | { result: unknown /* native result built by agent-host/interactions */ });
```

`sensitive` cards reject chat answers with 422 `sensitive_input_requires_native_entry`, as today.

**Attachments:** `POST /attachments` takes the raw body with these headers:
- `Content-Type`
- `Content-Length` (required)
- `X-File-Name` (RFC 5987 encoded)
- `X-Sha256` (optional, verified)

Bytes are stored content-addressed. `GET /attachments/:id` checks one of two conditions: the caller
uploaded the attachment, or the attachment is referenced by an event in a chat the caller can read. The
response sets `Content-Disposition` and `Cache-Control: private, max-age=31536000, immutable`, plus
`X-Content-Type-Options: nosniff`. Attachments that came in from a channel are fetched lazily through
`adapter.readAttachment` on first download and then promoted into the blob store. Agent outbound media
(`ChannelContent.media`) is written to the blob store and referenced from the event.

### 8.4 WebSocket protocol

Connect to `wss://<host>/_agent-router/v1/web/socket?ticket=<ticket>`. Browsers cannot set headers on a
WebSocket, so the client gets a ticket from `POST /socket-tickets` first.

```jsonc
// server → client, immediately after connecting
{ "type": "event", "event": "hello", "data": { "socketId": "so_…", "epoch": "ep_…", "heartbeatMs": 30000,
  "limits": { "maxSubscriptions": 200, "maxReplayEvents": 500 } } }

// client → server
{ "type": "req", "id": "1", "method": "subscribe",
  "params": { "chats": [ { "chatId": "dm:4f…", "afterSeq": 812, "generation": 1 } ], "index": true } }
{ "type": "req", "id": "2", "method": "unsubscribe", "params": { "chatIds": ["dm:4f…"] } }

// server → client
{ "type": "res", "id": "1", "ok": true, "result": { "chats": [ { "chatId": "dm:4f…", "mode": "delta", "lastSeq": 815 } ] } }
{ "type": "res", "id": "2", "ok": false, "error": { "code": "chat_not_found" } }
{ "type": "event", "event": "chat.event", "data": ChatEvent }
{ "type": "event", "event": "chat.stream", "data": { "chatId": "dm:4f…", "turnId": "t…", "agentId": "…",
  "state": "delta", "text": "<accumulated text so far>", "afterSeq": 815 } }
{ "type": "event", "event": "chats.updated", "data": ChatSummary }          // only with index:true
{ "type": "event", "event": "chat.read", "data": { "chatId": "…", "readSeq": 815 } }   // other tabs
{ "type": "event", "event": "snapshot_required", "data": { "chatId": "…", "reason": "gap_too_large" | "generation_changed" } }
```

Semantics:

- **Subscribe replay.** For each chat the server replays `seq > afterSeq` as `chat.event` frames, then
  goes live. If the gap is over 500 events or 1 MiB, or the generation differs, it sends
  `snapshot_required`. The client then calls `GET …/events` (latest page). The server's ring buffer is
  only an accelerator. The ledger is the replay source, so `epoch` (which changes on hub restart or DO
  wake) only tells the client that in-flight streams were dropped.
- **Ordering.** Per chat, `chat.event` frames arrive in strictly increasing `seq`. If the client sees
  `seq > last+1`, it fetches `…/events?after=last` and drops frames it already has.
- **Streams.** `chat.stream.text` carries the whole accumulated text, sent at most every 250 ms. A lost
  frame needs no repair. The stream ends with a durable `message` that has `final:true` and the same
  `turnId`, or with a `turn` event in a terminal state. Aborted and error streams are reported only
  through that `turn` event. After a reconnect, `inflight` from the history page restores the text.
- **Heartbeat.** The client sends the text frame `ping` every 30 s, and the server answers `pong`. This
  maps to the DO WebSocket auto-response.
- **Close codes:**
  - 4401: token no longer valid (re-checked every 10 min)
  - 4403: forbidden
  - 4408: backpressure (over 1 MiB buffered; reconnect and catch up)
  - 4429: too many sockets
  - 1012: restart

Commands are deliberately not carried on the socket. They go over HTTP, so they get the same
authentication, rate limiting, idempotency and retry behavior as every other request.

## 9. Identity

- A person has identities. Agents have routing aliases. The two never mix. A Feishu `open_id` is scoped
  to its app, so `namespace = app_id`. Mail subjects are lowercased addresses.
- Owner resolution at ingress has two steps:
  - Look up the person by identity.
  - Compare that person with `agent.owner_person_id`.

  This replaces the per-connection `ownerAddresses` lists once phase 6 seeds them.
- **Pairing** links a new channel identity to an existing person. The owner requests a code in the web
  console, sends `/link <code>` to the agent from that channel, and the control path handles it before
  dispatch. The identity is then linked with `verified_by='pairing'`, and the reply is "已关联到 <name>".
  Code rules:
  - 8 characters, Crockford base32, stored hashed
  - expires after 1 h
  - at most 3 pending per person
  - after 5 failed attempts from one sender, that sender is locked out for 1 h
  - single use

  The `/link` message itself is never written to a transcript.
- Strangers (non-owner senders on open channels) keep using today's visitor decision flow. Pairing is
  only for linking a person's own identities.

## 10. Backfill from Synapse and `timeline`

There are about 922 events. The backfill is a one-off offline command: `agent-router ledger backfill
[--agent <id>|--all] [--dry-run]`. It runs with the service stopped, at the phase 1 cutover, so that
backfilled events take the lowest seqs.

1. **Sources.** The first source is each agent's `timeline` collection (ordered by `cursor`), together
   with `rooms`/`room_info` for membership and the `ai.mau.room` group flag. Gaps are filled from Synapse
   `/rooms/{room}/messages` (dir=b, until the room's creation), called with the Application Service
   token acting as the agent's virtual user (ADR 0004), so no owner token is needed.
2. **Classification.** Each room is classified with the live adapter's rules. A room with the owner and
   one agent, without the group flag, is a DM and goes to `owner_main`. Every such DM room of that agent
   (the console currently shows only the most recent one) becomes a `participant` conversation of the
   one DM chat. Rooms flagged `ai.mau.room` group become hub rooms with `matrix_room_id` set. Other rooms
   go to `peer`/`group` sessions and appear as `observed` chats.
3. **Ordering and keys.** Events are sorted by `origin_server_ts`, with timeline cursor as tiebreaker,
   and written with `idempotency_key = matrix:<connectionId>:<event_id>`. This is the same key the live
   Matrix adapter produces, so later live events dedupe. A group event seen by several agents is written
   once to the hub room.
4. **Content.** `m.text`/`m.notice` become `message` events. Senders that are agents get `role:"assistant"`.
   `m.replace` becomes `edit` and `m.room.redaction` becomes `redaction`. Media becomes an attachment with
   a `channel` locator (`mxc://`). State events are skipped, except name and membership in rooms, which
   become `member` events. Every event's body gets `source:"backfill"`.
5. **Linking.** For each `communication_inbox` record whose `source.externalId` is a backfilled event id,
   the backfill creates a `ledger_turns` row (`turn_id = taskId`, state from `CliWork`) and sets the
   input's `turn_id`. For each `communication_outbox` row with `externalId`, the backfill attaches
   `turn_id`, sets `final` on that event, and creates a `ledger_deliveries` row with status `sent`. Open
   question cards (`communication_questions`, `closed:false`) become pending `ledger_cards`.
6. **Verification.** A dry run prints per-room counts (imported, skipped by type, unmatched inbox and
   outbox rows). A real run writes `meta.ledger_backfill = {at, counts}`. The run is idempotent: running
   it again inserts nothing. If a backfill ever runs after go-live, it bumps `generation`, and clients
   get `reset`.

## 11. Migration phases

Each phase ships on its own and can be rolled back by turning off its flag. The console decides per
feature with flags from `GET /me` → `limits.features`.

| Phase | Router | Console | Rollback |
| --- | --- | --- | --- |
| 0. Design and schema | This ADR. Empty tables and migrations. `OwnerAuthenticator` interface. No behavior change. | — | Not needed |
| 1. Shadow ledger | Ingress, dispatch, observation and flush write the ledger alongside the legacy records. Backfill. `GET /web/chats` and `/events` exist behind `ledger_read` for diffing. A debug endpoint compares ledger and timeline counts. | Unchanged (Matrix) | Ignore the tables |
| 2. Read via Router | Hub, socket, read markers. DM chats and observed chats are served from the ledger. | `history`: chat list, history and live updates for DMs come from Router. Sending still goes through Matrix (`PUT …/send`); the Matrix adapter ingests the message and it comes back on the socket. Run cards are keyed by `turnId` through `TurnDetail`. | Flag off, back to `/sync` |
| 3. Send via Router | `WebChannel` adapter. The dispatcher and flush read `ledger_pending_inputs`/`ledger_deliveries`. Legacy inbox and outbox are written for compatibility only. | `send`: `POST …/messages` with `idempotencyKey`. DMs no longer create Matrix rooms. | Flag off. Matrix send still works. |
| 4. Cards, attachments, control | Card events and the answer endpoint. Blob store and attachment endpoints. Cancel, steer and reset over HTTP. Questions and actions move to `ledger_cards`. | `cards`, `attachments`, `reset` | Flag off. Matrix text answers still work. |
| 5. Native groups | Hub rooms, fan-out, `RoomChannel`, group context. `ai.mau.room` groups are imported as rooms. The Matrix room receives a final "已迁移到 Mau" notice, and its new messages are ignored for that room. | `groups`: create, members, mentions | Flag off. Rooms already created stay readable. |
| 6. Identity | Persons and identities. Owner resolution by person. Pairing codes. A native `OwnerAuthenticator` (for example the existing `auth/exchange` OIDC bridge) beside Synapse whoami. | Identity settings page | Keep whoami |
| 7. Matrix optional | Matrix becomes an adapter per agent that can be disabled. Agents are created without Matrix accounts when it is off. `timeline` mirror is dropped. Synapse can be removed once no agent uses Matrix. | No Matrix code | — |
| 8. Durable Objects | Port (section 12). | No change (same API) | — |

The console's Matrix login stays in use for phases 1–5 because it supplies the bearer token. The
console needs its Matrix client only for login after phase 5.

## 12. Durable Object mapping

| Node (now) | Durable Objects (later) |
| --- | --- |
| `state/agents/<id>.sqlite` (`documents` plus `ledger_*`) | **AgentDO** per agent. Same tables in `ctx.storage.sql`. `transactionSync` replaces `BEGIN IMMEDIATE`. |
| `dispatch()`/`flush()`/`reconnect()` loops with `dispatching`/`flushing` guards | AgentDO `alarm()` set to `min(pending due, deliveries.next_at, observation poll)`. Single-threaded, so the guards are unnecessary. |
| `state/owners/<ownerKey>.sqlite`, `ws` server | **OwnerHubDO** per owner: rooms, chat index, read markers, fan-out. Hibernatable WebSockets (`acceptWebSocket`, tags = subscribed chat ids, `serializeAttachment({personId, subscriptions})`). `setWebSocketAutoResponse("ping","pong")`. |
| In-process publication signal | AgentDO → OwnerHubDO RPC `publish(sessionKey, fromSeq)`. The hub pulls and acknowledges, and `published_seq` advances. |
| Room fan-out | OwnerHubDO alarm → AgentDO RPC `ingest(roomMessage)`, idempotent by claim |
| `registry.sqlite` | **RegistryDO** (or D1): persons, identities, agents, routing aliases, connection → agent |
| `state/blobs` | R2, content-addressed (`sha256/<hex>`) |
| Channel pollers and webhooks | Worker → AgentDO, chosen by the connection → agent lookup in the registry. Pollers (Telegram, mail) run on AgentDO alarms. |
| Matrix AS transactions | Worker → per-agent AgentDO journal while Matrix exists |
| Host (external) | Unchanged. AgentDO polls or streams Host events, keeps the in-flight text in memory and in `communication_run_events`, and forwards `chat.stream` to the hub over RPC (not durable). |

Rules that make the port mechanical, applied from phase 1:
- No network call inside a transaction (already a `DurableStore` rule).
- No transaction spans two databases. Every cross-store effect is a cursor or idempotency-keyed row
  (`published_seq`, `hub_fanout`, deliveries).
- Seq is assigned only by the store that owns it.
- Ring buffers and streams may vanish on hibernation without losing correctness.
- Hot collections never need full scans (all paging uses indexed tables).

## 13. Alternatives considered

- **Keep Synapse as the record and add a Router read cache.** This leaves two truths. Run cards would
  still depend on Matrix ids, Feishu and mail would still be invisible in the console, and Synapse could
  never be removed.
- **One global ledger database.** It conflicts with the per-agent DO target and widens the effect of
  every failure. Per-agent ledgers plus a per-owner hub follow the ownership boundaries that already exist.
- **Copy group messages into every member agent's transcript.** That stores N copies and makes
  consistency harder. The room is canonical in the hub, and agents get bounded context at turn start.
- **SSE in place of WebSocket.** SSE is simpler in Node, but it keeps a DO awake for every open tab.
  WebSocket hibernation is the reason to choose WebSocket. A read-only SSE fallback can be added later
  if a proxy blocks WebSockets.
- **Persist streaming deltas.** That costs a lot of writes for no recovery value. The Host already keeps
  run events, and the final message is durable.

## 14. Open questions

1. **Merged owner DM.** The web DM chat shows the owner's Feishu, mail and Matrix messages to that agent
   (one `owner_main` session, with channel badges). This is assumed here. Confirm it.
2. **Where proactive notices go.** Web only (the default here), or also the owner's preferred external
   channel? If both, should the push channel be per owner or per agent?
3. **Mirroring web messages into Matrix** for owners who also use Element. The default here is off, and
   mirroring would only be a per-chat option.
4. **Reset scope.** Resetting `owner_main` from the web also resets the Feishu owner DM, because the
   session is shared. Is that acceptable, or should reset be web-only (which would need a separate web
   session)?
5. **Group context budget** (30 messages / 8 KB). Should agents be able to address each other in groups,
   with loop limits? Today they cannot.
6. **Edit and delete of the owner's own web messages.** Proposed for v1: neither. Should a message be
   retractable before its turn starts?
7. **Retention.** Transcript retention and purge policy (a purge bumps `generation`). Tombstones expire
   after 30 days; is that enough for every channel's redelivery window?
8. **Read markers.** Per person (as proposed), or per device?
9. **The public visitor ledger** (`src/channels/router.ts`, entries/visitors/decisions). Should it
   converge onto the same ingress, claim and transcript path in phase 6, or stay separate?
10. **The first native login provider**: the existing OIDC `auth/exchange`, Feishu OAuth, or email
    magic link.
11. **Feishu identity scope.** `open_id` is per app. Should `union_id` be used to link several Mau
    Feishu apps to one person?
12. **Shared agents.** An agent used by people other than its owner (team members) is out of scope. The
    `person_id`/`owner_person_id` split leaves room for an `agent_grants` table later.
13. **Mau's derived stores** (`memory_history`, completed turns). Should they move to consuming ledger
    final events, and if so, in which phase?
