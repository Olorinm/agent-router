# ADR 0005: Router-owned conversation ledger and web channel

- Status: accepted; phases 1–3 implemented behind flags (see "Implementation notes"); phases 4–7 decided and
  specified (sections 15–19); phase 8 (Durable Objects) later
- Date: 2026-11-05; phases 3–7 decisions 2026-11-06
- Affects: ADR 0002 (Matrix stops being the record of conversation history and becomes an optional adapter),
  ADR 0004 (from phase 6 owners log in through the edge identity, not a Matrix password)
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
3. Matrix becomes one more channel adapter. Synapse keeps running until phase 7 and can then be removed
   from a deployment; the adapter stays supported for operators who enable it (section 15).
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
8. **Login keeps using Synapse whoami until phase 6**, behind an `OwnerAuthenticator` interface. Phase 6 adds
   the edge identity (Cloudflare Access JWT, section 18.2) and keeps a bearer path for service callers.
9. **Migration ships in phases.** Phase 1 shadow-writes the ledger and backfills the about 922 existing
   events. After that, the web console switches one feature at a time (history, then send, then cards,
   then attachments, then groups) behind flags. The old records are dual-written until each consumer has
   moved. Phases 3–7 ship now; phase 8 (Durable Objects) later.

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
  uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL);   -- bytes live in the BlobStore under o/<ownerKey>/sha256/<aa>/<hex> (16.5)
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

1. **Control first.** Card answers by text or button, `/cancel`, `/steer`, `/new` and stale
   actions are handled as today (`HostWorker.handleInput`). `/link <code>` runs earlier, at ingress and
   before authorization (section 18.4). The input's state becomes `control`, and any
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
   **Only the owner's messages fan out.** An agent's message never triggers another agent, as today, even
   if its text contains `@name` (decided, section 15). Section 17 has the full phase 5 specification.
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
with idempotency `schedule:<eventId>`. It always reaches the web through the DM chat. In addition, one
channel delivery goes to the rule's configured channel (`notify.channel`, section 16.6); `"web"` means no
channel delivery. Fresh schedule sessions appear as `observed` chats.

### 6.8 Session reset

`POST …/reset` closes the current window, opens window *n+1* with `context_id = <key>.w<n+1>`, and
appends a `window` event. New turns start a new Host session. `seq` continues, so a chat stays one
scrollable history with a divider. Reset of `owner_main` affects every owner channel, because they
share the session (decided, section 15). The `/new` control command does the same from any owner channel.
Section 16.3 has the exact endpoint.

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
| `src/channels/router.ts` visitor ledger | Untouched through phase 7 (section 15.2, open question 3). | — |

## 8. Web channel API

### 8.1 Conventions

- Base path: `/_agent-router/v1/web`. Every route is owner-scoped. Agent ids appear only inside chat ids
  and bodies.
- Authentication: phases 1–5 use `Authorization: Bearer <Matrix access token>`, verified by
  `OwnerAuthenticator.authenticate(token) → { personId, ownerId, matrixUserId }`. The current
  implementation is `SynapseWhoamiAuthenticator`, which wraps `service.authenticate`, caches the result
  by token hash for 60 s, and never stores tokens. Phase 6 changes the interface to take the request and
  adds `CloudflareAccessAuthenticator` (the `Cf-Access-Jwt-Assertion` header) ahead of the bearer path
  (section 18.2).
- Errors use the existing shape: `{ "error": "snake_code", "retryAfterMs"?: number }` with HTTP
  400/401/403/404/409/413/422/429/503.
- Ids are opaque strings. Clients must URL-encode `chatId`, because it contains `:`.
- Times are ISO-8601 strings in responses.
- Caps:
  - text: 24 KB UTF-8 per send, 256 KiB per stored event
  - history page: `limit ≤ 200` and 1 MiB per response
  - attachments: 25 MiB per file, 10 per message, 30 MiB per message
  - sockets: 10 per person
  - rate: the existing 1200 requests/min/IP for all Router routes, plus 600 requests/min/IP on `/web`

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
  source: "host" | "mau-approval" | "mau-handoff"; // from the callId prefix (phase 4)
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
      steer?: boolean /* phase 4: steered into a running turn */; redacted?: boolean /* phase 4: text and attachments removed */;
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
| `POST /chats/dm` | `{ agentId }` | `ChatSummary`. Idempotent: one DM chat per agent. Creates the chat when it does not exist. |
| `GET /chats/:chatId` | — | `ChatSummary & { members: Actor[] }` |
| `GET /chats/:chatId/events` | query below | `EventPage` |
| `POST /chats/:chatId/messages` | `SendRequest` | `SendResponse` |
| `POST /chats/:chatId/reset` | `{ idempotencyKey, cancelActive? }` | `{ window, event: ChatEvent }` |
| `POST /chats/:chatId/read` | `{ seq }` | `{ readSeq, unread }`. Monotonic: a lower seq is ignored. |
| `GET /chats/:chatId/turns/:turnId` | — | `TurnDetail` |
| `POST /chats/:chatId/turns/:turnId/cancel` | `{}` | `{ status:"accepted" \| "already_finished" }` |
| `POST /chats/:chatId/turns/:turnId/steer` | `{ idempotencyKey, text }` | `{ status:"accepted" \| "unsupported" }` |
| `POST /chats/:chatId/cards/:cardId/answer` | `AnswerRequest` | `{ status:"accepted" \| "duplicate" \| "stale", card: Card }` |
| `POST /attachments` | raw body | `AttachmentRef` |
| `GET /attachments/:attachmentId` | — | bytes |
| `POST /groups` | `{ idempotencyKey, title, agentIds }` | `ChatSummary` |
| `PATCH /groups/:roomId` | `{ title?, archived? }` | `ChatSummary` |
| `POST /groups/:roomId/members` | `{ agentId }` | `{ members: Actor[] }` |
| `DELETE /groups/:roomId/members/:agentId` | — | `{ members: Actor[] }` |
| `GET /chats/:chatId/cards/:cardId` | — | `Card` (phase 4, section 16.1) |
| `POST /chats/:chatId/events/:eventId/redact` | `{ idempotencyKey }` | `{ status:"accepted" \| "duplicate", event: ChatEvent, dropped: boolean }` (phase 4; served from phase 3 with `send`, implementation note 12 of phase 3) |
| `POST /chats/:chatId/purge` | `{ idempotencyKey, confirm }` | `{ generation, purgedEvents }` (phase 4) |
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
| 409 | `idempotency_key_reused` (same key, different body), `agent_channels_not_configured` |
| 413 | `message_too_large` |
| 403 | `chat_read_only` |
| 422 | `mention_not_member`, `attachment_not_found`, `attachments_unsupported` (phase 3), `message_empty`, `reply_target_not_found` |
| 429 | `rate_limit_exceeded` with `retryAfterMs` |

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

Bytes are stored content-addressed in the `BlobStore` (section 16.5 has the full phase 4 specification). `GET /attachments/:id` checks one of two conditions: the caller
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
{ "type": "res", "id": "1", "ok": true, "result": { "chats": [ { "chatId": "dm:4f…", "mode": "delta", "lastSeq": 815, "generation": 1 } ],
  "errors": [ { "chatId": "obs:…", "code": "chat_not_found" } ] } }
{ "type": "res", "id": "2", "ok": false, "error": { "code": "invalid_request" } }
{ "type": "event", "event": "chat.event", "data": ChatEvent }
{ "type": "event", "event": "chat.stream", "data": { "chatId": "dm:4f…", "turnId": "t…", "agentId": "…",
  "state": "delta", "text": "<accumulated text so far>", "afterSeq": 815 } }
{ "type": "event", "event": "chats.updated", "data": ChatSummary }          // only with index:true
{ "type": "event", "event": "chat.read", "data": { "chatId": "…", "readSeq": 815 } }   // other tabs
{ "type": "event", "event": "snapshot_required", "data": { "chatId": "…", "reason": "gap_too_large" | "generation_changed" } }
```

Semantics:

- **Subscribe result.** Each requested chat is either in `result.chats` with `mode` `live` (no `afterSeq`
  given), `delta` (replay follows) or `reset` (a `snapshot_required` frame follows), or in `result.errors`
  with a code such as `chat_not_found`; only the chats in `result.chats` are subscribed. The result mode is
  informational: clients reload on the `snapshot_required` frame, not on `mode`. `ok:false` is used only for
  request-level errors (`invalid_request`, `too_many_subscriptions`, `operation_failed`); then nothing in the
  request was subscribed.
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
- **Login identity.** From phase 6 the console's person comes from the edge identity: a verified Cloudflare
  Access JWT whose email the operator maps to an owner id. The email is linked as an identity
  `("cloudflare-access", <team domain>, <lowercased email>)` with `verified_by='login'`. Section 18 has
  the authenticator, the pairing control path per channel and owner resolution by person.

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
| 4. Cards, attachments, control | Card events and the answer endpoint. Blob store (R2, local fallback) and attachment endpoints. Cancel, steer, reset, redaction and purge over HTTP. Schedule notices to web plus the rule's channel. Questions and actions move to `ledger_cards`. Section 16. | `cards`, `attachments`, `reset` | Flag off. Matrix text answers still work. |
| 5. Native groups | Hub rooms, fan-out, `RoomChannel`, group context. `ai.mau.room` groups are imported as rooms. The Matrix room receives a final "已迁移到 Mau" notice, and its new messages are ignored for that room. Section 17. | `groups`: create, members, mentions | Flag off. Rooms already created stay readable. |
| 6. Identity | Persons and identities. Owner resolution by person. Pairing codes across Feishu and mail. `CloudflareAccessAuthenticator` ahead of the bearer path; Mau's `/_mau/v1` uses the same check. Section 18. | No login page; identity settings page | Unset the edge config: whoami bearer again |
| 7. Matrix optional | Deployment switch plus per-agent Matrix state. Agents are created without Matrix accounts when it is off; Synapse-calling paths are gated. `timeline` mirror is dropped. Export, then remove Synapse and Postgres. Section 19. | Zero Matrix code paths when `features.matrix` is false | `AGENT_MATRIX=on` until Synapse data is deleted |
| 8. Durable Objects | Port (section 12). | No change (same API) | — |

The console's Matrix login stays in use for phases 1–5 because it supplies the bearer token. The
console needs its Matrix client only for login after phase 5, and not at all after phase 6 in a deployment
with an edge identity.

## 12. Durable Object mapping

| Node (now) | Durable Objects (later) |
| --- | --- |
| `state/agents/<id>.sqlite` (`documents` plus `ledger_*`) | **AgentDO** per agent. Same tables in `ctx.storage.sql`. `transactionSync` replaces `BEGIN IMMEDIATE`. |
| `dispatch()`/`flush()`/`reconnect()` loops with `dispatching`/`flushing` guards | AgentDO `alarm()` set to `min(pending due, deliveries.next_at, observation poll)`. Single-threaded, so the guards are unnecessary. |
| `state/owners/<ownerKey>.sqlite`, `ws` server | **OwnerHubDO** per owner: rooms, chat index, read markers, fan-out. Hibernatable WebSockets (`acceptWebSocket`, tags = subscribed chat ids, `serializeAttachment({personId, subscriptions})`). `setWebSocketAutoResponse("ping","pong")`. |
| In-process publication signal | AgentDO → OwnerHubDO RPC `publish(sessionKey, fromSeq)`. The hub pulls and acknowledges, and `published_seq` advances. |
| Room fan-out | OwnerHubDO alarm → AgentDO RPC `ingest(roomMessage)`, idempotent by claim |
| `registry.sqlite` | **RegistryDO** (or D1): persons, identities, agents, routing aliases, connection → agent |
| `BlobStore` (local disk or R2 over the S3 API, section 16.5) | R2 binding, same keys (`o/<ownerKey>/sha256/<aa>/<hex>`) |
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

The first draft's questions are settled in section 15:
- 1–7 and 10 were decided by the product owner on 2026-11-06 (15.1): the merged owner DM, the proactive
  notice target, Matrix mirroring, reset scope, agent-to-agent addressing in groups, edit and delete,
  retention, and the first login provider.
- 8 (read markers), 9 (visitor ledger) and 11 (Feishu `union_id`) were decided in this ADR (15.2).

Still open:

1. **Shared agents.** An agent used by people other than its owner (team members) is out of scope. The
   `person_id`/`owner_person_id` split leaves room for an `agent_grants` table later.
2. **Mau's derived stores** (`memory_history`, completed turns). Should they move to consuming ledger
   final events, and if so, in which phase? Not required by phases 3–7.
3. **The public visitor ledger** (`src/channels/router.ts`, entries/visitors/decisions). It stays separate
   through phase 7 (section 15.2). Converging it onto the ledger ingress is a phase 8 candidate.
4. **Mail sender authentication.** Pairing and owner resolution over mail trust the provider's sender
   address. Whether each mail provider exposes a DKIM/SPF verdict Router can require is unverified
   (section 18.4).

## 15. Phases 3–7 decisions

### 15.1 Decided by the product owner (2026-11-06)

| # | Decision | Specified in |
| --- | --- | --- |
| 1 | **Scope.** Phases 3–7 are built now. Phase 8 (Durable Objects) comes later; the rules of section 12 still apply to every phase. | 11 |
| 2 | **Matrix is off in our deployment but stays a supported, optional channel adapter.** Operators can enable it per deployment and per agent. Agent creation works without a Matrix account when it is off. Existing agents' Matrix identities may stay dormant. After phase 7, Synapse and its Postgres can be removed from our deployment. Mirroring web messages into Matrix (old open question 3) is not built. | 19 |
| 3 | **Login uses the edge identity from Cloudflare Access.** Router verifies the `Cf-Access-Jwt-Assertion` JWT and maps the verified email to an owner through operator config. The console has no login page and holds no token. A bearer path stays for service and ops callers; Access service tokens map to an owner only when configured. Mau's `/_mau/v1` routes authenticate the same way. | 18.2, 18.3 |
| 4a | **The web DM merges the owner's messages from all channels** to that agent (one `owner_main` session), each with a channel badge. | 5, 8.2 |
| 4b | **"New chat" resets the shared owner session for all channels.** | 6.8, 16.3 |
| 4c | **Schedule results go to the web plus the rule's configured channel.** | 6.7, 16.6 |
| 4d | **Agents cannot trigger each other in groups.** Only the owner's `@agent` or `@all` fans out. No loop limits are needed. | 6.5, 17 |
| 4e | **The owner can redact (not edit) their own web messages.** | 16.4 |
| 4f | **Transcripts are kept forever.** The owner can purge a chat manually. Ingress tombstones keep their 30-day expiry. | 16.4 |
| 5 | **Attachments live in Cloudflare R2**, content-addressed by sha256, with size caps, a per-owner key prefix and a local-disk store for tests and development. | 16.5 |

### 15.2 Decided in this ADR (not by the product owner)

These choices were needed to make the specs implementable. Each can be revisited without changing the rest.

1. **R2 access from the VM uses the S3-compatible API** with a bucket-scoped access key, signed with
   `aws4fetch` (no AWS SDK). A Worker binding was rejected for now: it adds a second deployment and its own
   authentication between the VM and the Worker. In phase 8 the same `BlobStore` interface gets an R2
   binding implementation.
2. **Downloads are proxied through Router**, same-origin, never as signed R2 URLs. A signed URL works for
   anyone who holds it, bypasses Access and leaks through history, logs and `Referer`. Proxying keeps the
   per-request permission check, and with the edge identity a plain `<img src>` works, because the browser
   sends the Access cookie and Cloudflare adds the JWT.
3. **Blob keys are per owner** (`o/<ownerKey>/sha256/<aa>/<hex>`). Deduplication only happens inside one
   owner, so the store cannot tell one owner that another owner holds the same file.
4. **Person ids stay derived from owner ids** (`personId(ownerId)`, implementation note 7). Owner ids stay
   strings of the form `@<local>:<serverName>` even without Synapse, so agent addresses, Mau records and
   hub file names do not change.
5. **Read markers stay per person** (old open question 8), not per device.
6. **Card answers through the web reuse `RunObservation.resolve`**, so Mau's synthetic `mau-approval:` and
   `mau-handoff:` calls work without new Mau endpoints, and Mau keeps the authority over its own calls.
7. **Reset refuses while a turn is active** unless the request sets `cancelActive: true`.
8. **Purge implies reset**: the purged chat continues in a new window, so the model context goes with the
   transcript.
9. **Redaction never reaches the model.** An unstarted input is dropped; a started one is only hidden in
   the transcript.
10. **`/link` pairing is accepted only in direct conversations** and runs before authorization, so an
    unknown sender can use it. It writes nothing to any transcript.
11. **Feishu `union_id`**: when Feishu supplies it, pairing also links `("feishu-union", <tenant key>,
    union_id)`, so one person can be recognized across several Mau Feishu apps (old open question 11).
12. **The public visitor ledger stays separate** through phase 7.
13. **The per-agent runtime keeps `MatrixConnector` and its store** when Matrix is off. A dormant transport
    replaces Synapse. Renaming the runtime away from "Matrix" is a refactor for phase 8.
14. **The browser handoff URL is not stored in the transcript.** The stored card text has the private
    link replaced. The live text is served only while the card is pending (section 16.1).

### 15.3 Phase 3 (send via Router)

Phase 3 is specified by sections 6, 8.3 ("Send") and 11, with no changes beyond decision 4a.
- Flag: `AGENT_LEDGER_SEND=1` sets `features.send`.
- The `WebChannel` adapter (`kind:"web"`, `retrySafe:true`, no deliveries) writes into the `owner_main`
  session through the `web` conversation.
- With the flag off, the console keeps sending through Matrix while Matrix is enabled. With Matrix off
  (phase 7), `send` must be on.

## 16. Phase 4: cards, control and attachments

Flags (each sets the matching `limits.features` entry):

| Env | Feature | Requires |
| --- | --- | --- |
| `AGENT_LEDGER_CARDS=1` | `cards` | `send` |
| `AGENT_LEDGER_CONTROL=1` | `reset` (also covers cancel, steer, redaction, purge) | `send` |
| `AGENT_LEDGER_ATTACHMENTS=1` | `attachments` | `send` and a blob store (16.5) |

### 16.1 Card answers

```http
POST /_agent-router/v1/web/chats/dm%3A<agentId>/cards/cd_7f3a…/answer
{ "idempotencyKey": "01JC9W2Q8E5ZK3V4R6T7Y8U9I0", "choiceId": "0" }
{ "idempotencyKey": "01JC9W2Q8E5ZK3V4R6T7Y8U9I1", "text": "用 staging 环境" }
{ "idempotencyKey": "01JC9W2Q8E5ZK3V4R6T7Y8U9I2", "result": { "answers": { "env": { "answers": ["staging"] } } } }

200 { "status": "accepted" | "duplicate" | "stale", "card": Card }
```

`Card` gains `source: "host" | "mau-approval" | "mau-handoff"`, taken from the `callId` prefix. Steps:

1. **Scope.** Resolve the chat. The card must belong to the chat's session, or, for a room chat, be mirrored
   into that room (section 17). It is then handled by the card's agent. Otherwise 404 `card_not_found`. An
   `observed` chat gives 403 `chat_read_only`.
2. **Idempotency.** `hub_commands(personId, idempotencyKey)`: the same request hash returns the stored
   response with `status:"duplicate"`. A different hash gives 409 `idempotency_key_reused`.
3. **State.** A card that is not `pending` returns `status:"stale"` with the current card. A `sensitive`
   card gives 422 `sensitive_input_requires_native_entry`.
4. **Build the native result.**
   - `choiceId`: from `ledger_card_tokens(card_id, choice_id)`. Unknown gives 422 `choice_not_found`.
   - `text`: read the live call from `RunObservation.run(claimId).calls` (for Mau this goes through
     `BusinessHost.calls`, which lists the synthetic calls). Then apply `interaction(call).answer(text)`,
     exactly as a chat answer does. A thrown code gives 422 `invalid_answer` with `detail` set to that code
     (`structured_answers_required`, `question_answer_missing`, `interaction_choice_required`). A call that
     is no longer pending makes the card `expired` and returns `stale`.
   - `result`: accepted only for `source:"host"` cards of kind `question` (the native result built by
     `@olorinm/agent-host/interactions`). Synthetic cards need `choiceId` or `text`, which gives 422
     `choice_or_text_required`, because Mau validates their result shape narrowly.
5. **Plan.** In one agent-ledger transaction, set `answer_key = web:<personId>:<idempotencyKey>`, `result`,
   `answered_by = personId` and `answer_surface = 'web'`. The status stays `pending`.
6. **Resolve.** Call `RunObservation.resolve(claimId, callId, result)`, which checks the call scope as
   today.
   - For `mau-approval:` the call lands in `ConnectorApprovals.decide` (`{choice:"once"|"deny"}`).
   - For `mau-handoff:` it lands in `answerHandoff`. "取消接管" ends the handoff. Any free text is steered
     to the run, as Mau does for a chat reply.
   - Every other call goes to the Host.
   - `interaction_not_found` (404) makes the card `expired` and returns `stale`.
   - A Host or network failure returns 503 and leaves the planned answer in place. The worker re-resolves
     planned cards (`status='pending' AND answer_key IS NOT NULL`) on each tick. The Host arbitrates
     repeated identical answers, and Mau ignores decided cards.
7. **Commit.** Set the card status and append `card.update` with `answeredBy` (the person) and `summary`
   (the choice label, or the first 140 characters of the text). If the card's origin conversation is an
   external channel, also queue a `notice` delivery "已在网页回答。" there.

Status mapping:
- `connector_approval`: `once` → `approved`, `deny` → `rejected`.
- `approval`: the first (allow) choice of `approval`, `permission` or `*requestApproval` → `approved`; the
  deny choice → `rejected`. For `session/request_permission`, an option whose `kind` starts with `allow` →
  `approved`, and one that starts with `reject` → `rejected`.
- Anything else → `answered`.

**One record for every answer surface.** All of the following go through one
`CardLedger.recordAnswer(cardId, { surface, by, result, summary })`:
- chat text and buttons (`HostWorker.handleInput`)
- the run surface (`POST …/runs/:claimId/calls/:callId/result`)
- Mau's `POST …/communication/calls/:callId/result`
- the web endpoint

The worker's call observation closes the rest. A call that leaves `pending` without a Router answer becomes
`answered` (resolved in the Host's own UI), `expired` (deadline) or `canceled` (run ended). The first answer
wins, and later ones get `stale`. `communication_questions`, `_actions` and `_control_receipts` stop being
read in this phase: control receipts become the planned-answer columns, and button tokens become
`ledger_card_tokens`.

**Handoff cards.** For `mau-handoff:` the stored `card` event text has every `https://` URL replaced by
`[私密链接，仅在卡片待处理时显示]`. `GET /chats/:chatId/cards/:cardId` returns the live `Card`. While the
card is pending, its `text` is rebuilt from the live call. Once it is closed, the text is the stored
(redacted) one. External channel deliveries of the card keep today's text, because they go only to the
owner's own conversation.

### 16.2 Cancel and steer

```http
POST /_agent-router/v1/web/chats/:chatId/turns/:turnId/cancel
{}
200 { "status": "accepted" } | { "status": "already_finished", "state": "completed" }

POST /_agent-router/v1/web/chats/:chatId/turns/:turnId/steer
{ "idempotencyKey": "01JC…", "text": "顺便把结论写成表格" }
200 { "status": "accepted", "event": ChatEvent } | { "status": "unsupported" }
409 { "error": "turn_not_running" }
```

Both endpoints share these rules:
- The turn must belong to the chat's session, or, in a room chat, to a member agent's room session.
  Otherwise 404 `turn_not_found`. `observed` chats give 403 `chat_read_only`.

Cancel:
- Calls `work.cancel(turnId)`. The Host cancel follows through the worker, as today, and the turn becomes
  `canceled` through the normal turn event.
- Appends `notice` "正在停止当前任务。" with idempotency `cancel:<turnId>`.
- `RunObservation.cancel` switches its scope check from the inbox scan to `ledger_turns`, so work and
  schedule turns can be canceled too.

Steer:
- A `hub_commands` row is planned before the Host call.
- Requires the turn's active binding to be `running` with a `runId`, then calls `host.steer`. Through Mau,
  this passes Mau's own owner-admission check.
- On success the ledger appends a `message` with `role:"user"`, `body.steer: true` and the turn's
  `turn_id`, with idempotency `web:<personId>:<key>`. The console renders it inside the run surface.
- `host_steer_unsupported` (or a kernel refusal) returns `unsupported` and appends nothing.
- A retry after a crash may steer the same text twice. Kernels treat steer text as additive, so this is
  accepted.

### 16.3 Reset ("新对话")

```http
POST /_agent-router/v1/web/chats/:chatId/reset
{ "idempotencyKey": "01JC…", "cancelActive": false }
200 { "window": 3, "event": ChatEvent /* kind:"window", reason:"reset" */ }
409 { "error": "session_busy", "activeTurns": ["t…"], "queuedInputs": 1 }
```

- Allowed for `dm` and `group` chats (for a group, see section 17.5).
- If the session has a `queued`/`running`/`waiting` turn or `queued` pending inputs, the reset is refused
  unless `cancelActive` is true. In that case it cancels the turns, sets queued inputs to `dropped` (reason
  `reset`), and resets. Late events of a canceled turn still land, tagged with the old `window`.
- One agent-ledger transaction does the reset:
  - close the window (`reason:'reset'`)
  - open `context_id = <key>.w<n+1>`
  - increment `ledger_sessions.window`
  - append the `window` event
- The dispatcher passes the window's `context_id` to `work.send` from then on, so the next turn opens a new
  Host session. Mau's per-session records (`business_session_instructions` and others) are keyed by session
  id and therefore start fresh too.
- **Every owner channel is affected** (decision 4b).
- From any owner channel, the control commands `/new`, `/reset` and `新对话` run the same reset (with
  `cancelActive:false`). They reply with a `notice` "已开始新对话。" (or "当前任务进行中，请先停止。") to
  that conversation only. A web reset sends nothing to external channels; the `window` event is shown in the
  web.

### 16.4 Redaction and purge

```http
POST /_agent-router/v1/web/chats/:chatId/events/ev_01JC…/redact
{ "idempotencyKey": "01JC…" }
200 { "status": "accepted" | "duplicate", "event": ChatEvent /* kind:"redaction" */, "dropped": true }
403 { "error": "redaction_not_allowed" }
```

Redaction:
- Only `message` events that the caller sent through the `web` conversation (or into a room) can be
  redacted. Messages that entered through Feishu, mail or Matrix, and agent messages, give 403.
- One transaction:
  - The target body becomes `{ "redacted": true, "redactedAt": "<iso>" }`. Text, HTML and attachment
    references are removed. Attachment rows lose their `event_id`, and blob references are released (16.5).
  - A `redaction` event is appended.
  - If the target's pending input is still `queued`, it becomes `dropped` (reason `redacted`) and the
    response has `dropped: true`. In a room, its `queued` `hub_fanout` rows are deleted.
- A started input is not withdrawn from the model (decision 15.2.9).
- History responses return the redacted body, so a client that never saw the original still shows "已撤回".

```http
POST /_agent-router/v1/web/chats/:chatId/purge
{ "idempotencyKey": "01JC…", "confirm": "dm:<agentId>" }
200 { "generation": 4, "purgedEvents": 1832, "window": 5 }
```

Purge (manual, decision 4f):
- `confirm` must equal the `chatId`. Otherwise 422 `purge_confirmation_required`.
- In the agent ledger (or the hub for a room), one transaction:
  - deletes all events of the session, their `ledger_platform_messages`, attachment rows and event-bound
    deliveries
  - turns every `ledger_ingress` claim of the session into a `tombstone` (the hash is kept, and it expires
    after 30 days), so a redelivered channel message does not come back
  - bumps `generation`, resets `published_seq`, and opens a new window (purge implies reset)
- Clients get `reset`.
- Execution records (`communication_runs`, run archives, Host sessions) are kept, because they are the
  audit trail of what ran. Mau's derived memory is not purged either. The console's confirm dialog says
  so: "聊天记录将被永久删除；Agent 已经写入的记忆不会被删除。"
- The merged DM includes the owner's Feishu, mail and Matrix messages to that agent. Purging the DM purges
  them as well.

### 16.5 Attachments and the blob store

```ts
interface BlobStore {
  /** Idempotent. Bytes come from a verified temp file; the key is content-addressed. */
  put(key: BlobKey, file: { path: string; size: number; sha256: string; md5: string; contentType: string }): Promise<void>;
  head(key: BlobKey): Promise<{ size: number } | null>;
  get(key: BlobKey, range?: { start: number; end?: number }): Promise<{ body: Readable; size: number; start: number; end: number }>;
  delete(key: BlobKey): Promise<void>;
}
type BlobKey = { ownerKey: string; sha256: string };     // object key "o/<ownerKey>/sha256/<aa>/<hex>"
```

Implementations:
- `LocalBlobStore`: `state/blobs/o/<ownerKey>/sha256/<aa>/<hex>`. Atomic rename from a temp file in the
  same directory. Used for tests and development, and as the default when no R2 is configured.
- `R2BlobStore`: S3 API over HTTPS with `aws4fetch` (region `auto`).
  - `PutObject` sends `If-None-Match: *` and `Content-MD5`. R2 checks the MD5, and a 412 (already present)
    counts as success.
  - `HeadObject`, `GetObject` with `Range`, and `DeleteObject`.
- Config:

  ```
  AGENT_BLOB_STORE=r2
  AGENT_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
  AGENT_R2_BUCKET=agent-router-blobs
  AGENT_R2_ACCESS_KEY_ID_FILE=…
  AGENT_R2_SECRET_ACCESS_KEY_FILE=…
  ```

  The key is an R2 API token limited to "Object Read & Write" on that one bucket. The bucket has no public
  access and no custom domain.
- Phase 8: `R2BindingBlobStore` on `env.BUCKET`, with the same keys.

Upload:

```http
POST /_agent-router/v1/web/attachments
Content-Type: image/png
Content-Length: 482113
X-File-Name: UTF-8''%E6%88%AA%E5%9B%BE.png
X-Sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08     (optional)

201 { "attachmentId": "at_01JC…", "name": "截图.png", "contentType": "image/png", "size": 482113,
      "sha256": "9f86…0a08", "url": "/_agent-router/v1/web/attachments/at_01JC…" }
```

- Requires `features.attachments` and a `Content-Length` of at most 25 MiB (`411`/`413
  attachment_too_large`). The body streams to a temp file while sha256 and md5 are computed. A body longer
  than its `Content-Length` is cut off and rejected. A mismatched `X-Sha256` gives 422 `sha256_mismatch`.
- Per-owner quota: `limits.attachmentQuotaBytes` (default 5 GiB, counted over distinct blobs). Over quota:
  413 `attachment_quota_exceeded`.
- The upload rate limit is 60 per minute per person.
- If `head` misses, the bytes are `put`. Then one hub transaction upserts `hub_blobs` and inserts a
  `hub_uploads` row plus the reference `upload:<attachmentId>`.
- Uploads that no message references within 24 h are deleted with their reference.

Send binding:
- `SendRequest.attachments` (at most 10, 30 MiB total) must be the caller's own unbound uploads.
  Otherwise 422 `attachment_not_found`.
- The send transaction copies them into `ledger_attachments` (DM: locator `{"blob":"sha256:<hex>"}`,
  `event_id` set) or into `hub_room_attachments` (room). The `upload:` reference is replaced by
  `agent:<agentId>:<attachmentId>` or `room:<roomId>:<attachmentId>`.
- The model sees them as today. `WebChannel.readAttachment` and `RoomChannel.readAttachment` read the blob
  (cap `MAX_MEDIA_BYTES`) into `MediaContent`.
- Agent outbound media (`ChannelContent.media`) on a web or room turn is written to the blob store under
  the owner's prefix and attached to the final event.

Download:

```http
GET /_agent-router/v1/web/attachments/at_01JC…          (Range supported)
200/206  Content-Type: <stored type, or application/octet-stream>
         Content-Disposition: inline; filename*=UTF-8''…    (images, audio, video, PDF only; otherwise attachment)
         Cache-Control: private, max-age=31536000, immutable
         X-Content-Type-Options: nosniff
         Content-Security-Policy: sandbox; default-src 'none'
```

- Permission: the caller uploaded it, or it is referenced by an event in a chat the caller can read.
  Otherwise 404.
- Channel attachments (`{"channel":…}` locators) are read lazily through `adapter.readAttachment`, then
  promoted to the blob store, and the locator is rewritten.
- Before phase 6 the console fetches attachments with its bearer token and shows them through
  `URL.createObjectURL`. With the edge identity, plain same-origin URLs work.

Reference counting:
- `hub_blob_refs(sha256, ref)` holds one row per upload, agent attachment and room attachment.
- Redaction and purge delete references. A sweeper deletes a blob from the store, and its `hub_blobs` row,
  when no reference has been left for 7 days. The delay covers in-flight sends and backups.

### 16.6 Schedule notice targets

Mau's proactive rule gains `notify: { channel: "web" | "<connectionId>" }`. The default for new rules is
`"web"`. Existing rules are migrated to the connection of their target session's most recent owner
conversation, or to `"web"` if that is Matrix and Matrix is off.

Router's `WorkSessions.deliver` gains `connectionId?: string`:
- It always appends the `notice` (`schedule:<eventId>`) to the target session. That is the web delivery.
- If `connectionId` is set, it queues one `content` delivery to the session's conversation on that
  connection with the latest `last_inbound_at`.
- Without such a conversation, the delivery is `suppressed` with error `no_conversation_on_connection`. The
  web still has the notice.
- The receipt Mau stores (`status`, `externalId`) is the channel delivery's, or `{status:"web"}` when
  there is none.

### 16.7 Console (Mau `web/`)

| Feature | Change |
| --- | --- |
| `cards` | Card events render as cards in the run surface. Buttons call `answer` with `choiceId`. Free-text cards have an input that calls `answer` with `text`. Connector approvals use the existing approval view (`native.params`), answering through `answer` in place of `runApi().answer`. Handoff cards fetch `GET …/cards/:cardId` for the live link while pending. `card.update` folds into the card. |
| `reset` | "新对话" button. On `session_busy` a dialog "当前任务进行中" offers "停止并开始新对话" (`cancelActive:true`). The run surface gets "停止" (cancel) and "补充" (steer). Own web messages get "撤回" (redact). Chat settings get "清空聊天记录" (purge, with a typed confirmation). |
| `attachments` | The composer accepts files and paste. Each file is uploaded as a `Blob` body (never a `ReadableStream`; client contract 8) with a progress bar, and then the `attachmentIds` are sent. Images render inline. |

`runApi().answer` and `runApi().cancel` stay for the Matrix-sourced console until phase 7.

### 16.8 Schema

```sql
-- AGENT_LEDGER_V3
ALTER TABLE ledger_cards ADD COLUMN source TEXT NOT NULL DEFAULT 'host';      -- host | mau-approval | mau-handoff
ALTER TABLE ledger_cards ADD COLUMN answer_surface TEXT;                      -- web | channel | run-api | host
CREATE INDEX ledger_cards_planned ON ledger_cards(updated_at) WHERE status = 'pending' AND answer_key IS NOT NULL;
-- OWNER_HUB_V2
CREATE TABLE hub_uploads(attachment_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL,
  size INTEGER NOT NULL, uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL, bound_at INTEGER);
CREATE TABLE hub_blob_refs(sha256 TEXT NOT NULL, ref TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(sha256, ref));
CREATE TABLE hub_room_attachments(attachment_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, event_id TEXT, name TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER, sha256 TEXT, locator TEXT NOT NULL, created_at INTEGER NOT NULL);
ALTER TABLE hub_blobs ADD COLUMN unreferenced_at INTEGER;
```

### 16.9 Tests

- `test/ledger-cards.test.ts`:
  - choice, text and native answers for each `interaction()` family
  - `mau-approval:` through a `BusinessHost` stub: `once` → `approved`, `deny` → `rejected`, and the result
    shape Mau parses
  - `mau-handoff:` cancel and free-text steer
  - sensitive gives 422
  - duplicate and stale answers, a different key after an answer elsewhere
  - crash between plan and resolve: the worker re-resolves once
  - an answer from the run API or chat updates the same card
  - handoff URL redaction in history, live text from `GET …/cards/:cardId`
- `test/ledger-control.test.ts`:
  - cancel of channel, work and schedule turns
  - steer accepted and unsupported
  - reset: busy, `cancelActive`, the next turn's `contextId` is `<key>.w2`, `/new` from a Feishu owner DM
    resets the web DM
  - redaction: queued input dropped, started input kept, a foreign-channel message refused
  - purge: generation bump, tombstoned claims ignore a redelivery, the chat continues in a new window
- `test/ledger-attachments.test.ts`, against `LocalBlobStore` and an `R2BlobStore` pointed at a fake S3
  server:
  - 411, 413, sha mismatch, quota
  - dedupe per owner, no dedupe across owners
  - permission on download, Range
  - inline versus attachment disposition and the CSP header
  - lazy promotion of a channel attachment
  - refcount sweep after redaction
- `test/ledger-web.test.ts`: `/me` features follow the flags.
- Mau: `web/src/api/ledger.test.ts` for the answer, reset and upload clients; a console test that a `cards`
  console never calls `runApi().answer`.

### 16.10 Risks

- **Two answer paths race.** A chat text answer and a web answer can arrive together. The Host arbitrates,
  and the ledger keeps the first `card.update`. The loser sees `stale`.
- **Purge is irreversible and wide** (the merged DM covers all channels). It needs a typed confirmation and
  no undo. Backups follow the operator's state backup policy.
- **Proxying downloads costs VM bandwidth** (at most 25 MiB per file). Phase 8 serves from the R2 binding.
- **The R2 key on the VM** can read every owner's blobs. It is stored as a file readable only by the
  service user and is bucket-scoped, and the bucket is private.

## 17. Phase 5: native groups

Flag: `AGENT_LEDGER_GROUPS=1` sets `features.groups`. It requires `send`. With the flag off, room chats
stay readable, and room commands give 403 `feature_disabled`.

### 17.1 API

```http
POST /_agent-router/v1/web/groups
{ "idempotencyKey": "01JC…", "title": "周报小组", "agentIds": ["<agentId-1>", "<agentId-2>"] }
201 ChatSummary & { "members": Actor[] }          // chatId "room:rm_01JC…", kind "group"
422 { "error": "agent_not_found" }                // not owned or not active
429 { "error": "room_limit_reached" }             // 100 rooms per owner

PATCH /_agent-router/v1/web/groups/rm_01JC…
{ "title": "周报", "archived": false }
200 ChatSummary                                   // appends member{action:"rename"} on a title change

POST /_agent-router/v1/web/groups/rm_01JC…/members
{ "agentId": "<agentId-3>" }
200 { "members": Actor[] }                        // appends member{action:"add"}

DELETE /_agent-router/v1/web/groups/rm_01JC…/members/<agentId-3>
200 { "members": Actor[] }                        // appends member{action:"remove"}

POST /_agent-router/v1/web/chats/room%3Arm_01JC…/messages
{ "idempotencyKey": "01JC…", "text": "@研究助理 帮我查一下", "mentions": { "agentIds": ["<agentId-1>"], "all": false } }
200 { "status": "accepted", "event": ChatEvent,
      "addressed": [ { "agentId": "<agentId-1>", "state": "queued" }, { "agentId": "<agentId-2>", "state": "not_addressed" } ] }
```

Validation and membership:
- `title` is 1–64 characters. `agentIds` has 1–20 unique agents, all owned and active.
- The owner is the only person member.
- The client resolves mentions; the server never parses `@` from the text. `mentions.agentIds` must be
  members, otherwise 422 `mention_not_member`. A message with no mention is stored and fans out to nobody.

Removal:
- Removing an agent deletes its `queued` fan-out rows and archives its room session.
- Deleting an agent removes it from every room (a `member` event).
- A room with no agents stays readable.

### 17.2 Fan-out

One hub transaction appends the room event and one `hub_fanout` row per addressed agent:
- `mentions.agentIds ∩ members`, or every member agent with `all`
- only when the sender is the owner person (decision 4d)

Agent messages, cards and notices never create fan-out rows, whatever their text says.

The fan-out worker:
- takes due rows in `(room_id, agent_id, seq)` order
- delivers one agent's rows strictly in order; a failing row blocks that agent's later rows in that room
- calls the agent's ingress through `RoomChannel` (it opens the runtime if needed):

```ts
{ externalId: `${roomId}:${seq}`, sender: ownerId, scope: "group", groupId: `room:${roomId}`,
  threadId: room.matrixRoomId ?? `room:${roomId}`,          // see 17.6: imported rooms keep their session
  text, attachments, mentions: { self: true, all }, privateGroup: true,
  reply: { target: roomId, messageId: eventId, data: { roomId } } }
```

- The ledger claim `(room, <roomId>:<seq>)` makes redelivery harmless.
- Backoff is 1 s × 2ⁿ, capped at 5 min. After 24 h the row is `failed`, and the room gets a `notice`
  (`level:"warning"`) "未能送达 <agent>：<error>".
- Room turns use the same owner admission as Matrix private groups do today (`privateGroup: true`, owner
  sender).

### 17.3 Group context

`hub_room_cursors(room_id, agent_id, context_seq)` records how far each agent has seen the room. When the
dispatcher starts a room turn, `RoomChannel.context(roomId, agentId, originSeq)` returns room `message`
events with `context_seq < seq < originSeq`. It skips redacted events, the agent's own messages and inputs
already addressed to it. In the same transaction as the turn start, the cursor moves to `originSeq`.

The context is prefixed to the model input:

```
群聊上下文（自你上次参与以来 12 条，省略 4 条）：
[10:42] 主人: 这周的数据出来了吗
[10:43] 写作助理: 初稿已经放在共享文件夹
[附件: 周报.docx]
```

Caps:
- the newest 30 messages and 8 KB in UTF-8, oldest dropped first
- each message cut to 1 KB
- attachments listed by name only

### 17.4 Replies, cards, turns and streams

`RoomChannel` has `kind:"room"` and `retrySafe:true`.
- Capabilities: receive `text`, `image`, `file`, `quote`; send `text`, `html`, `image`, `file`;
  `buttons:true`, `stream:true`.
- `send(route, text, deliveryId)` appends an assistant `message` to the room with idempotency
  `delivery:<agentId>:<deliveryId>`, `replyTo` = origin event, `turnId` and `final`. The room `eventId` is
  the platform message id, and the delivery is `sent` at once. `sendContent` writes media to the blob store
  first.
- The agent's `card`, `card.update` and `turn` events are mirrored into the room with idempotency
  `card:<cardId>`, `card.update:<cardId>:<status>` and `turn:<turnId>:<state>`. The mirrored bodies carry
  `agentId`.
- `POST /chats/room:<id>/cards/:cardId/answer` resolves through the card's agent (16.1), and
  `GET /chats/room:<id>/turns/:turnId` resolves through the turn's agent.
- `chat.stream` frames use the room `chatId` and carry `agentId`. Several agents can stream at once.

### 17.5 Room reset

`POST /chats/room:<id>/reset` resets the room session of every member agent (the 16.3 rules; the busy check
covers all of them). It appends one `window` event to the room and moves every cursor to the current
`last_seq`.

### 17.6 Importing `ai.mau.room` Matrix groups

The import is an explicit command, run once per deployment while Synapse and the service are running:
`agent-router ledger import-rooms (--owner <ownerId> | --all) [--dry-run]`. For each Matrix room with
`ai.mau.room {kind:"group"}` state whose joined members are exactly the owner and the owner's agents:

1. **Hub room.** `importRoom` creates the hub room and its members. This is already implemented, and the
   id is derived from the Matrix room id.
2. **History.** Live Matrix ingress since the phase 1 backfill wrote only agent-side sessions, not the hub
   room. The import pages Synapse `/messages` backwards (as an agent's virtual user, with the AS token)
   until it reaches a known `matrix:<event_id>`, and appends the missing events in order.
3. **Session continuity.** `RoomChannel` messages for an imported room use the Matrix room id as `threadId`.
   The legacy formula therefore gives each agent the session key its Matrix group session already had, so
   the model context continues. The import sets that `ledger_sessions` row to `kind='room'` and fills in
   `room_id`.
4. **Freeze.** The registry document `matrix_room_migrations[<matrixRoomId>] = { roomId, at }` is written.
   From then on `MatrixChannel` claims messages from that room as `ignored` (`room_migrated`): no transcript
   event and no turn.
5. **Final notice.** The member agent with the lowest id sends one `m.notice`: "此群聊已迁移到 Mau
   网页端，这里的新消息不会再被处理。" Its transaction id is `digest(["room-migrated", matrixRoomId])`, so a
   rerun never sends it twice. Agents stay joined, so Element users can still read the old history.
6. **Late messages.** Steps 2–5 are idempotent. A rerun imports anything that arrived before the freeze.

Groups that include anyone outside the owner and the owner's agents are not imported. They stay Matrix
groups (observed chats) while Matrix is enabled, and become read-only history in phase 7. The dry run
lists every room as `import`, `skip:has_outsiders`, `skip:not_group` or `skip:unknown_members`.

### 17.7 Console

The `groups` feature adds:
- a "新建群聊" dialog (title and agent picker)
- a member panel (add, remove and rename)
- an `@` picker listing member agents plus "@所有人"
- a hint while composing a message without a mention: "未 @ 任何 Agent，消息只记录"
- the `addressed` state under the sent message
- per-agent run surfaces inside the room

Matrix group creation (`MauConversations` `createRoom` with `ai.mau.room`) is hidden when `groups` is on.

### 17.8 Schema (`OWNER_HUB_V3`)

```sql
CREATE TABLE hub_room_cursors(room_id TEXT NOT NULL, agent_id TEXT NOT NULL, context_seq INTEGER NOT NULL,
  PRIMARY KEY(room_id, agent_id));
CREATE INDEX hub_fanout_due ON hub_fanout(next_at) WHERE status = 'queued';
CREATE INDEX hub_room_members_agent ON hub_room_members(member_id) WHERE member_type = 'agent';
```

### 17.9 Tests (`test/ledger-rooms.test.ts`)

- Group create is idempotent; limits; non-owned agents are refused; membership events.
- Mention validation. Only the owner fans out: an agent reply containing `@另一个Agent` reaches nobody.
  `@all` addresses every member.
- Fan-out order per agent, retry after a crash (the claim dedupes), the failure notice after 24 h.
- Group context: caps, the cursor, exclusion of own inputs and messages, redacted messages skipped.
- Replies land in the room with `replyTo`. Card mirror and an answer from the room chat. Room reset.
- Import:
  - a private group is imported, a group with outsiders is skipped
  - the history gap is filled
  - the session key is unchanged
  - the final notice is sent exactly once
  - a later Matrix message is ignored with `room_migrated`
- With the flag off: reads work, commands give 403.

### 17.10 Risks

- **Cost of `@all`** in a 20-agent room. Rooms are capped at 20 agents, and turns are queued through each
  agent's normal capacity.
- **Owners still posting in Element** after the import get no reply. The final notice is the only signal.
- **The context cap** loses detail in busy rooms. The cap values live in `limits` and can be tuned.

## 18. Phase 6: identity and edge login

Flags:

| Env | Effect |
| --- | --- |
| `AGENT_LEDGER_IDENTITY=1` | Sets `features.identity`: owner resolution by person, pairing codes and the identity page. |
| `AGENT_EDGE_IDENTITY_FILE=<path>` | Enables `CloudflareAccessAuthenticator` (18.2). |

The two can be turned on separately.

### 18.1 Persons and owner resolution

- Owner ids stay strings (15.2.4), and `personId(ownerId)` stays the person id. Every agent's
  `owner_person_id` is `personId(agent.owner)`.
- The owner check in `CommunicationCore` and `HostWorker` becomes:

  ```
  persons.resolve(provider, namespace, sender) === personId(agent.owner)
  ```

  For one release after phase 6, `|| connection.ownerAddresses.includes(sender)` is kept as well. The
  configured `ownerAddresses` are still seeded at every start as `verified_by='config'` identities, so
  operator config keeps working.
- Provider and namespace per channel:

  | Channel | Provider | Namespace |
  | --- | --- | --- |
  | Feishu | `feishu` | `app_id` |
  | Feishu, when `union_id` is supplied | also `feishu-union` | `tenant_key` |
  | grove-mail / agentmail | the channel kind | `''` (subject lowercased) |
  | Telegram | `telegram` | `''` |
  | Weixin | `weixin` | the account id |
  | Matrix | `matrix` | the server name |
  | Edge login | `cloudflare-access` | the team domain host |

- `DELETE /identities/:identityId` revokes the identity (`revoked_at`). The sender stops being the owner
  from its next message on. Errors:
  - revoking a `config` identity: 409 `identity_from_config` (change the config instead)
  - revoking the login identity of the current request: 409 `identity_in_use`
- A sender that becomes the owner keeps its earlier `peer` sessions as observed chats. Its new messages
  enter `owner_main` as a `participant` conversation. A conversation never moves (section 5).

### 18.2 `CloudflareAccessAuthenticator`

The interface changes to take the request:

```ts
interface OwnerPrincipal {
  personId: string; ownerId: string;
  via: "edge" | "edge-service" | "bearer";
  email?: string; matrixUserId?: string; expiresAt?: number;
}
interface OwnerAuthenticator { authenticate(request: { headers: IncomingHttpHeaders }): Promise<OwnerPrincipal> }
```

`ManagedService.authenticateRequest(req)` is the one entry point for every owner-authenticated route:
- the `/_agent-router/v1` owner middleware
- the web router
- the gateway's owner (non-`ari_`) branch
- Mau

`authenticate(token)` stays for callers that only hold a token.

Operator config (a JSON file, outside the repository):

```json
{ "edgeIdentity": {
    "provider": "cloudflare-access",
    "teamDomain": "https://example-team.cloudflareaccess.com",
    "audiences": ["0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"],
    "clockSkewSeconds": 60,
    "bearer": "allow",
    "owners": {
      "owner@example.test": "@owner:example.test",
      "second@example.test": { "owner": "@second:example.test", "sub": "6f1c2d3e-0000-4000-8000-000000000000" }
    },
    "serviceTokens": { "1a2b3c4d5e6f.access": "@owner:example.test" }
} }
```

Config validation at start (zod; a bad config fails the start):
- `teamDomain` is an `https` origin without a path.
- `audiences` has 1–10 non-empty tags.
- `owners` keys are lowercased emails. Values are owner ids, or `{owner, sub}` to pin the identity
  provider's subject.
- Owner ids follow today's rule: a Matrix-shaped id ending in `:<serverName>`, never `@_ar_…`.
- `clockSkewSeconds` is 0–300.
- The config is reloaded only on restart.

Verification, using `jose` (no hand-written JWT code):
1. Read `Cf-Access-Jwt-Assertion` (at most 8 KB). Router never reads `Cf-Access-Authenticated-User-Email`
   or the `CF_Authorization` cookie. Only the signed assertion counts.
2. Verify with these settings:
   - `jwtVerify(token, jwks, { algorithms: ["RS256"], issuer: teamDomain, audience: audiences,
     clockTolerance: clockSkewSeconds, requiredClaims: ["exp", "iat"] })`
   - `nbf` is checked when present, and a present `type` must be `"app"`
   - `jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain), { timeoutDuration: 5000,
     cooldownDuration: 30000, cacheMaxAge: 3600000 })`
   - an unknown `kid` refetches at most once per cooldown, which covers key rotation
   - if the keys cannot be fetched and none are cached: 503 `identity_provider_unavailable`
3. Map the identity:
   - A non-empty `email` is NFC-normalized, lowercased and looked up in `owners`. No entry gives 403
     `owner_not_configured`, and the error body includes `email` so the console can show it. A pinned
     `sub` that differs gives 403 `owner_subject_mismatch`.
   - Otherwise a `common_name` (an Access service token's client id) is looked up in `serviceTokens`. No
     entry gives 403 `service_token_not_configured`.
   - With neither: 401 `edge_identity_invalid`.
4. Cache the principal by `digest(token)` until `min(exp, now + 60 s)`.
5. On first sight per cache entry:
   - `persons.ensurePerson(ownerId, <email local part>)`
   - `persons.link(person, "cloudflare-access", <teamDomain host>, email, "login")`; a service token links
     `service:<common_name>` with `config`
   - update `last_seen_at`

Order of checks (`CompositeAuthenticator`):
1. With an edge config and the header present, the edge result decides. A bad JWT is a 401 and never falls
   back to the bearer path, so a broken edge session cannot be downgraded silently.
2. Otherwise a bearer token uses today's path (Synapse whoami, `ars_` sessions), unless `bearer:"deny"`,
   which gives 401 `edge_identity_required`.
3. With neither: 401 `account_login_required`.
4. If both an edge JWT and a bearer token are present and resolve to different owners: 401
   `principal_conflict`.

`ari_` instance tokens on the gateway are unchanged.

Socket tickets:
- `POST /socket-tickets` works for every principal.
- The ticket keeps the authenticating credential (the bearer token or the JWT) in memory only, as today.
- The 10-minute re-check re-verifies it, and an edge principal's socket closes with 4401 at its `exp`.
  Cloudflare Access also applies to the WebSocket upgrade, so the ticket request and the upgrade carry the
  same cookie.

`GET /me` gains `"auth": { "via": "edge", "email": "owner@example.test", "expiresAt": "…" }`.

### 18.3 Mau and the console

Mau (`src/app.ts`):
- The `/_mau/v1` product middleware calls `router.service.authenticateRequest(req)` in place of
  `authenticate(<bearer>)`. `attachSsh` passes the upgrade request the same way.
- `GET /_mau/v1/info` returns `{ "login": "edge", "logoutUrl": "/cdn-cgi/access/logout", "matrix": false }`,
  or the legacy `{ "login": "matrix", "homeserver": "https://matrix.example.test", "matrix": true }`.
- `GET /_mau/v1/account` returns `{ owner, person: { id, name }, via }`.

Console (`web/src/api/session.ts`, `http.ts`):
- With `login:"edge"` there is **no login page**. Boot calls `/_mau/v1/info`, removes any stored
  `mau.session`, then calls `GET /_agent-router/v1/web/me` (same-origin credentials, no `Authorization`).
  - 200: the app starts with that principal. Every later request is sent without a token; Cloudflare adds
    the JWT from the Access cookie.
  - 403 `owner_not_configured`: a full-page "此账号未开通 Mau（<email>）" with "切换账号" → `logoutUrl`.
  - `access_session_expired`: `request()` already turns an edge redirect into this code. The console shows a
    banner "登录已过期" with "重新登录", which saves unsent composer text per chat in `sessionStorage` and
    then calls `location.reload()`. Access signs the owner in again and returns to the same URL.
  - A socket close 4401 asks for a new ticket. If that request gives `access_session_expired`, the banner
    is shown.
- The menu's "退出登录" goes to `logoutUrl`. The Matrix password form and token paste are shown only for
  `login:"matrix"`.
- CLIs (`mau`, the Go `agent-router`) get an edge mode. The owner runs `cloudflared access login
  https://mau.example.test`, and the CLI sends the token as the `cf-access-token` header (Access validates
  it and injects the JWT). Automation uses an Access service token (`CF-Access-Client-Id` and
  `CF-Access-Client-Secret`) mapped in `serviceTokens`.

### 18.4 Pairing codes

```http
POST /_agent-router/v1/web/identities/pairing-codes
{}
201 { "code": "7KQ4-M2XD", "expiresAt": "2026-11-06T09:00:00.000Z",
      "instructions": "在要关联的渠道里私聊你的任一 Agent，发送：/link 7KQ4-M2XD" }
429 { "error": "pairing_codes_pending_limit" }
```

The code rules of section 9 apply: 8 Crockford base32 characters shown with a hyphen, stored as
`digest(["pairing", ownerKey, normalized])`, 1 h, at most 3 pending, single use. Input is
case-insensitive, hyphens and spaces are ignored, and `I`/`L` → `1`, `O` → `0`.

Ingress hook. It runs after the claim and **before** authorization, so an unknown sender can pair:
- **Match.** Only `scope:"direct"` messages whose whole text matches
  `^\s*(?:/link|绑定)\s+[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}\s*$`. In groups, `/link` is ignored without a reply,
  so a code is never confirmed in front of others.
- **Lockout.** `hub_pairing_failures` is keyed by `digest(provider, namespace, subject)` in the hub of the
  receiving agent's owner. Five failures in 1 h lock the sender for 1 h: "尝试次数过多，请一小时后再试。"
- **Match the code** against the agent owner's pending codes. On success, `persons.link(person, provider,
  namespace, subject, "pairing")`. For Feishu, `feishu-union` is linked as well when supplied. Then
  `consumed_at` and `consumed_identity` are set.
  - Reply: "已关联到 <name>。之后在这里发给 Agent 的消息会进入你的主对话。"
  - An identity already linked to another person is left unchanged, with the reply "此账号已关联到其他用户。"
  - A wrong or expired code counts as a failure: "关联码无效或已过期。"
- **Mail** pairs only when the adapter marks the sender as verified (`native.senderVerified === true`, from
  the provider's DKIM/SPF/DMARC verdict). Otherwise: "无法验证发件人，未关联。" Whether each mail provider
  exposes this is open question 4. Until it is confirmed, mail pairing is off for that provider.
- **No transcript.** The claim becomes `ignored` with reason `pairing`, with no event and no turn. The reply
  is a `notice` delivery with `event_id` NULL on the message's own route.

### 18.5 Identity page (console, `identity` feature)

The page:
- lists identities with provider, subject, `verified_by` and last seen
- offers "解除关联" (DELETE; config and in-use identities are shown as fixed)
- offers "生成关联码", showing the code, a countdown and per-channel instructions

### 18.6 Schema (`REGISTRY_V2`, `OWNER_HUB_V4`)

```sql
ALTER TABLE reg_person_identities ADD COLUMN last_seen_at INTEGER;
-- hub
CREATE TABLE hub_pairing_failures(sender_key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL,
  locked_until INTEGER);
CREATE INDEX hub_pairing_pending ON hub_pairing_codes(person_id) WHERE consumed_at IS NULL;
```

### 18.7 Tests

- `test/edge-identity.test.ts`. A local RSA key pair is created with `jose`, and the JWKS is served from a
  local HTTP server.
  - Accepted: a valid user JWT.
  - Rejected: wrong `aud`, wrong `iss`, `exp` and `nbf` outside the skew, `alg` `HS256`/`none`, a forged
    signature.
  - Keys: an unknown `kid` refetches once; rotation; JWKS down with a cache (accepted) and without (503).
  - Identity: email case and NFC; unmapped email (403, with `email` in the body); pinned `sub` mismatch;
    service token mapped and unmapped.
  - Ordering: bearer `allow` and `deny`; `principal_conflict`; a forged `Cf-Access-Authenticated-User-Email`
    without a JWT is ignored.
  - Sockets: a ticket from an edge principal; a 4401 close at `exp`.
- `test/pairing.test.ts`:
  - success: a Feishu DM links (with `union_id`); a Matrix DM links
  - ignored: `/link` in a group
  - failures: an expired, reused or wrong code; lockout after five failures; an identity already linked to
    another person; an unverified mail
  - no event or turn is written
  - the linked sender becomes the owner on the next message; revoking takes owner rights away again; config
    identities cannot be revoked
- Mau: `/_mau/v1` with an edge principal; `/info` in both modes; the console in edge mode shows no login
  form, shows the `access_session_expired` banner and reloads, and shows the `owner_not_configured` screen.

### 18.8 Risks

- **Access coverage.** `/_agent-router/v1/*`, `/_mau/v1/*`, the socket path and the console must sit
  behind one Access application with the configured AUD. A bypass policy on a sub-path would send requests
  there without a JWT, and they fall back to the bearer path. Use `bearer:"deny"` once no bearer callers
  remain.
- **Email reuse at the identity provider.** A recycled address would inherit the owner. Pin `sub` for each
  owner where possible.
- **A leaked service token** gives owner access. Scope the Access policy for service tokens to the paths
  they need, and rotate them.
- **Spoofed mail** already grants owner rights through `ownerAddresses` today. Requiring verified mail for
  pairing does not fix the existing `ownerAddresses` trust. The same verdict should later gate mail owner
  resolution.

## 19. Phase 7: Matrix optional

### 19.1 Switches

**Deployment.** `AGENT_MATRIX=on|off` (`ServiceConfig.matrix.enabled`).
- The default is `on`, so existing deployments do not change. Ours sets `off`.
- With `off`, `homeserver`, `asToken` and `hsToken` are optional and unused. `serverName` stays required,
  because it is the owner-id namespace (15.2.4).
- `GET /me` → `limits.features.matrix` reports the deployment switch explicitly (client contract 1).

**Per agent.** `ManagedAgent.matrix` is one of three states. A missing value counts as `active` (legacy
records).

| State | Meaning |
| --- | --- |
| `none` | Never had an account. Agents created while Matrix is off get this. |
| `dormant` | Has an Application Service account that is not used. |
| `active` | Provisioned, and the Matrix adapter runs. |

Agent API responses gain `"matrix": { "state": "none", "userId": null }`. `matrixId` stays in the
response for compatibility (the Go CLI reads it). It is the agent's runtime identity whether or not it is
registered.

```http
PUT /_agent-router/v1/agents/<agentId>/matrix          (deployment on only)
{ "enabled": true }
200 { "state": "active", "userId": "@_ar_<id>:example.test" }
409 { "error": "matrix_disabled" }                      // deployment off
409 { "error": "agent_has_active_or_unknown_run" }
```

`enabled:true`:
- registers the AS user (`M_USER_IN_USE` is fine)
- swaps the runtime's transport (the `configureRuntime` sequence)
- sets a new Matrix `activation` checkpoint, so Matrix events queued during the dormant period are ignored
- lets Mau add the `matrix` connection

`enabled:false` makes the agent `dormant`: the adapter stops, the account is kept, and its rooms stay
joined but are ignored.

### 19.2 Gated paths

| Path | Matrix on (agent `active`) | Matrix off, or agent `none`/`dormant` |
| --- | --- | --- |
| `ManagedService.create` | registers the AS user, `matrix_agents` row | no Synapse call. `matrix:"none"`, no `matrix_agents` row. |
| `ManagedService.open` | `ApplicationTransport`, owner contact, display name | `DormantTransport`: `identity()` returns `matrixId`, `dormant = true`. `MatrixConnector.start` runs no sync loop when the transport is dormant. Send, room and state calls give `matrix_disabled`. Contacts are local. The display name is skipped (`meta.matrix_initialized` is kept separate from `managed_initialized`). |
| `ManagedService.delete` | deactivates the account | skipped. A dormant account is listed by `agent-router matrix forget`. |
| `/_matrix/app/v1/*` | mounted | not mounted (generic 404) |
| `authenticate(<Matrix token>)` | Synapse whoami | 401 `matrix_disabled`. `ars_` sessions still work. |
| `ExternalIdentitySessions.provision` | Synapse admin account | an `external_owners` record only, active at once |
| `GET /directory` | `matrixId` | `matrixId: null` |
| Connection API, `kind:"matrix"` | allowed | 409 `matrix_disabled`. Existing Matrix `ConnectionDefinition`s are kept but not registered; their status shows `disabled: "matrix_off"`. |
| Gateway Matrix social API (`/api/contacts`, `/api/conversations`) | as today | 409 `matrix_disabled` |
| `ledger backfill --synapse`, `ledger import-rooms` | as today | error `matrix_disabled` |
| Mau `environments.ts` | adds the `{id:"matrix", kind:"matrix"}` connection | adds nothing (`router.service.matrixEnabled(agentId)` is false) |
| Mau `/_mau/v1/info` | `login:"matrix"` unless edge is configured | `login:"edge"` (an edge config is required when Matrix is off) |

The per-agent runtime keeps `MatrixConnector`, its `ConnectorStore`, `CliWork` and the per-agent SQLite
file (15.2.13). `timeline`, `room_info` and `read_markers` are no longer written when nothing syncs.

### 19.3 Console with `features.matrix = false`

- `api/conversations.ts` (`MauConversations`), the Matrix password login, the Matrix chat source and the
  `mau.chatSource` toggle load only through a dynamic `import()` behind `features.matrix` or
  `login:"matrix"`.
- With Matrix off:
  - the chat source is always the ledger
  - nothing requests `/_matrix/…` or `/info.homeserver`
  - Matrix and Element wording and links are hidden
- Observed chats that came from Matrix sessions still render as history, with the badge "Matrix（已停用）".

### 19.4 Migration and removal of Synapse

Preconditions:
1. Phases 3–6 have been on for at least one release, and owners use only the ledger console.
2. `agent-router ledger import-rooms --all` has run, and every imported group shows the final notice.
3. Every owner has logged in through the edge identity. `GET /web/debug/identity` (operator only) lists
   owners with the `last_seen_at` of their login identity.
4. No live dependency on Matrix remains. Check `delegation` sessions, and `peer`/`group` sessions on
   Matrix connections, with inbound traffic in the last 30 days. A2A delegation over Matrix rooms stops; the
   HTTP A2A gateway keeps working. Affected owners are told.

Export, with Synapse still running:

5. **Final backfill.** With the service stopped: `npm run ledger:backfill -- --all --synapse`. Check
   `/debug/ledger`: unmatched counts are zero or explained.
6. **Media.** `agent-router ledger promote-media --all --channel matrix` copies every `mxc://` attachment
   referenced by ledger events into the blob store (AS token) and rewrites the locators. The check: zero
   channel locators remain for Matrix connections. **Once `media_store` is deleted, unpromoted media is
   lost.**
7. **Manifest.** `agent-router matrix export --all --out <dir>` writes JSON with:
   - agents with their Matrix ids and states
   - owner ids
   - rooms with name, members and the `ai.mau.room` flag
   - room → conversation or hub room mappings
   - per-room event counts
8. **Synapse data.**
   - `pg_dump --format=custom` of the Synapse database, test-restored into a scratch Postgres
   - an archive of `media_store/`
   - `homeserver.yaml`, the server signing key and the AS registration file, kept for a possible
     re-enable under the same server name

   All of it is encrypted and stored offline, indefinitely (the original record; decision 4f).

Switch:

9. Set `AGENT_MATRIX=off` and an edge config, then restart. Verify:
   - a new test agent gets `matrix:"none"`
   - web and Feishu send and receive
   - `features.matrix` is false
   - the service makes no connections to the homeserver
10. **Soak for at least 7 days.** Rollback during the soak: `AGENT_MATRIX=on` and restart. Agents resume
    with a new activation checkpoint, so Matrix events from the off period are not processed late. Web
    messages from the off period are not in Matrix (one-way).

Removal:

11. Stop Synapse and Postgres, and delete their volumes once item 8 has been verified.
12. Remove the AS registration, and delete `asToken`, `hsToken` and the Synapse admin token from the
    secrets.
13. Remove `/_matrix` and `/.well-known/matrix` from the edge (Access application, tunnel ingress, DNS).
14. `agent-router matrix forget --all [--dry-run]` deletes:
    - the per-agent `timeline`, `room_info`, `read_markers`, `rooms` and `meta.sync` documents
    - the registry's `as_queue:*`, `as_members`, `matrix_agents` and `matrix_room_migrations`
    It then sets every agent to `matrix:"none"`.

### 19.5 Tests

- `test/managed.test.ts`, with Matrix off:
  - `create` makes no homeserver request; the runtime starts; `CliWork` accepts work; a web DM turn
    completes
  - `delete` skips deactivation
  - `/_matrix/app/v1` gives 404, a Matrix bearer gives 401 `matrix_disabled`, `ars_` works
  - a Matrix connection is refused; a configured one is skipped with its status
  - `ExternalIdentitySessions.exchange` works without Synapse
- With Matrix on:
  - the per-agent toggle switches between `active` and `dormant`
  - re-enabling ignores Matrix events from before the new activation checkpoint
- `matrix forget --dry-run` counts. `promote-media` rewrites locators and is idempotent.
- Mau:
  - `environments.ts` adds no Matrix connection when Router reports Matrix off
  - in a console test with `features.matrix=false`, a fetch mock fails on any `/_matrix/` URL, and a build
    assertion checks that the entry chunk does not contain `conversations.ts`

### 19.6 Risks

- **Hidden Matrix dependencies.** `matrixId` appears in agent cards, contacts and the Go CLI. Every
  remaining use is either listed in 19.2 or must work with an unregistered id. The test suite runs once
  with Matrix off.
- **Irreversible export gaps.** Media that was not promoted, or rooms that were not backfilled, are lost
  with Synapse. Items 5–8 are preconditions of removal, not cleanup.
- **External Matrix peers** lose the channel. They are found in item 4.
- **CLI login** depends on Matrix today. The CLI edge mode (18.3) must ship before Synapse is removed.

## Implementation notes (phases 1–2)

Phases 1 and 2 are implemented in `src/ledger/` (read-only; no send). These choices fill gaps in the text above or
deviate from it where the code required:

1. **Scope.** Implemented: all `ledger_*`, `hub_*` and `reg_*` tables (`DurableStore.migrate(version, sql, name)`;
   the registry uses its own meta row `registry_schema_version`), shadow writes, backfill, the read-only web API
   (`/me`, `/socket-tickets`, `/chats`, `/chats/:chatId`, `/chats/:chatId/events`, `/chats/:chatId/read`,
   `/chats/:chatId/turns/:turnId`, `/debug/ledger`) and the event socket. Deferred: `POST /chats/dm`, send, reset,
   card answers, attachments, groups, pairing (phases 3–6). `GET /me` reports them in `limits.features` as `false`.
   `POST /chats/dm` is served from phase 2: a DM chat exists for every owned active agent, so it only resolves it.
   Hub rooms are created only by backfill and are not served yet.
2. **Flag.** The web API and socket are mounted only with `ServiceConfig.ledgerRead` (`AGENT_LEDGER_READ=1`).
   Shadow writes are always on for agents opened by `ManagedService`; a core built on a store without
   `AgentLedger.open` writes nothing.
3. **Shadow safety.** Every ledger write runs in a SQLite savepoint inside the legacy transaction (or its own
   transaction). A ledger error rolls back only the ledger rows, is kept in `AgentLedger.lastError` (shown by
   `/debug/ledger`) and never changes the legacy path.
4. **Unknown senders.** Their claim is `ignored` (`sender_not_allowed`) and no conversation or session is created
   (section 6.1 step 3 runs before authorization in the text; that would create sessions for strangers).
5. **Conversation keys** are derived generically from `ChannelMessage`: direct → `peer_id` = sender,
   `parent_id` = reply target; group → `peer_id` = `groupId` (else reply target); `thread_id` = the legacy
   `threadId` when it differs from both. Session keys are exactly the legacy `conversationId`, so section 5's
   legacy formula holds without per-channel code.
6. **Idempotency keys.** Ingress and backfill both use `<connectionId>:<externalId>` (section 6.1). Section 10.3's
   `matrix:<connectionId>:<event_id>` would not dedupe against live ingress, so it is not used. Hub room events
   use `matrix:<event_id>`. Imported room ids are derived (`rm_` + digest of the Matrix room id) instead of a ULID
   so that every agent of the owner imports the same room.
7. **Persons.** `person_id` is derived from the owner id (`prs_` + digest) so that hub, registry and ledgers agree
   without lookups; `matrix_agents` documents are not changed (they are plain strings today). Seeded identities:
   the owner's Matrix id and each connection's `ownerAddresses` (`verified_by='config'`). Namespace: Feishu
   `app_id`, Matrix server name, `''` for every other provider. Owner decisions still use `ownerAddresses`.
8. **Turns.** `running`/`unknown` come from the Host worker, terminal states from `publishResults` (channel turns)
   or the worker (work and schedule turns, which have no channel input). Each state appends one `turn` event.
   The automatic "重新执行 / 不用了" card for unknown turns (6.2.4) belongs to the phase 3 dispatcher.
9. **Cards.** Question notices are written as `card` events (with `ledger_cards` and tokens) by the Host worker;
   chat answers write `card.update answered`, run end writes `expired`. Answers from other surfaces
   (`runs/:claimId/calls/:callId/result`) are not tracked until phase 4.
10. **Deliveries.** Every legacy outbox transition updates `ledger_deliveries`; a stale activity is `suppressed`.
    The route column holds the frozen `ReplyRoute` plus `channel` (used for `DeliveryState.channel`).
    `delivery` events are appended for `sent`, `unknown`, `rejected` and `suppressed` of event-bearing rows.
11. **Schedule notices.** `WorkSessions.deliver` passes `schedule:<eventId>`; the notice has no `turnId` and its
    delivery has `purpose='content'` (it still uses the legacy content outbox).
12. **Tombstones.** `tombstone()`/`pruneTombstones()` exist and claims honor them, but nothing purges live
    transcripts yet, so no tombstones are created in phases 1–2.
13. **Oversized bodies** are cut to fit 256 KiB and marked `truncated: true` until the blob store exists (phase 4).
14. **History edge cases.** `after` greater than `lastSeq` returns `reset` with reason `not_found`; `before` and
    `after` together are a 400. A latest page that exceeds 1 MiB keeps the newest events. `inflight` is read from
    `communication_runs` + `communication_run_events` (a document scan, bounded by run count).
15. **Socket.** `ws` is a new runtime dependency. `createRouter().upgrade(req, socket, head)` must be attached to
    the HTTP server's `upgrade` event (done in `agent:service`; embedders must do the same, and must not reject
    upgrades for paths they do not own before Router has seen them). Unknown chats in a subscribe request are
    reported per chat in `result.errors` (see 8.4). Without `afterSeq` the result mode is `live`. Subscribing opens
    the agent runtime when needed, as HTTP routes do.
    Replay over 500 events or 1 MiB gives `snapshot_required` with `gap_too_large`; `afterSeq > lastSeq` gives
    `not_found`.
16. **Backfill.** `npm run ledger:backfill -- (--agent <id> | --all) [--dry-run] [--synapse] [--state <dir>]`
    (the Go CLI does not wrap it yet). It takes the agent store lease, so it fails while the service runs.
    `--dry-run` runs everything in one transaction per agent and rolls it back (the empty tables are still
    created). `--synapse` pages `/messages` backwards per room as the agent's virtual user with the AS token.
    If a session already had events and receives older history, it is re-sequenced by time, its `generation`
    is bumped and `published_seq` reset, so clients get `reset`. Only Matrix inbox/outbox records are linked;
    legacy records of other channels from before the cutover are not backfilled.

## Implementation notes (phase 4: attachments and the blob store)

The attachment part of section 16.5 is implemented in `src/ledger/blobs.ts` (stores), `src/ledger/blobs-hub.ts`
(`OwnerAttachments`: uploads, permissions, reference counting, sweeper, send binding) and `src/ledger/blobs-web.ts`
(routes). Cards, control (cancel, steer, reset, redaction, purge) and schedule targets are not part of this change.

1. **Flag and config.** `ServiceConfig.ledgerAttachments` (`AGENT_LEDGER_ATTACHMENTS=1`, needs `ledgerRead`) builds
   `ManagedService.attachments` and sets `features.attachments`. Phase 3's `send` is not on `main` yet, so the flag
   does not check it; once `send` lands, `attachments` must also require it (section 16 table). `GET /me` adds
   `limits.attachmentQuotaBytes` while the feature is on. Blob store: `ServiceConfig.blobStore` =
   `{ kind: "local", dir? }` (default `<stateDir>/blobs`) or `{ kind: "r2", bucket, accessKeyIdFile,
   secretAccessKeyFile, endpoint? | accountId? }` (`AGENT_BLOB_STORE=r2`, `AGENT_R2_*` as in 16.5, plus
   `AGENT_R2_ACCOUNT_ID` as an alternative to the endpoint, `AGENT_BLOB_DIR`, `AGENT_ATTACHMENT_QUOTA_BYTES`).
   The key files are read once when the service is built. Embedders and tests can pass
   `ServiceDependencies.blobStore` instead. Nothing in the store logs; errors carry codes only.
2. **R2.** Path-style `<endpoint>/<bucket>/<key>`. `PutObject` sends `X-Amz-Content-Sha256` (the verified hash, so the
   payload is signed), `Content-MD5`, `If-None-Match: *` (412 is success); the file is read into memory (at most
   30 MiB). `http:` endpoints are accepted only on loopback (tests). The request timeout covers the response
   headers; download bodies stream.
3. **Upload.** The service JSON parser skips `POST /web/attachments`, so any content type (including
   `application/json`) streams raw. A chunked body or no `Content-Length` gives 411 `content_length_required`; early
   rejections close the connection. `Content-Type` parameters are dropped (`text/html; charset=utf-8` →
   `text/html`). `X-File-Name` is RFC 8187 (`UTF-8''…`) or ASCII; separators and controls become `_`, at most
   200 bytes, default `attachment`. A body shorter than `Content-Length` gives 400 `upload_incomplete`. The rate
   limit (60/min) is keyed by person.
4. **Order of writes.** Upload: quota pre-check → spool to `<stateDir>/tmp/uploads` while hashing → (per owner and
   sha256 lock) `head`/`put` → one hub transaction that re-checks the quota and writes `hub_blobs`, `hub_uploads`
   and `upload:<id>`. If that transaction fails and the owner held no such blob, the object is deleted again. The
   in-process lock also serializes lazy promotion and the sweeper, so a sweep never deletes an object an upload
   has just found present (single Router process; phase 8 gets this from the Durable Object).
5. **Download.** Lookup order: the caller's own upload, a bound room attachment (phase 5), then the agent ledgers
   of the owner's active agents (the `agent:<agentId>:<id>` reference is a fast path; otherwise each owned agent is
   opened, as history does). Only rows with `event_id` set are readable. 404 everywhere else. `Range` supports one
   `bytes=a-b`, `a-` or `-n` range; several ranges get the whole body; 416 carries `Content-Range: bytes */<size>`.
   Responses also carry `Accept-Ranges` and `ETag: "sha256:<hex>"`.
6. **Lazy promotion.** A `{"channel":…}` row is read through `ServiceExtension.readAttachment(inputId, reference)`
   (`CommunicationCore.readStoredAttachment`: the claim's input → `communication_inbox` source →
   `adapter.readAttachment`, reusing the `communication_media` cache when the model already read it). The bytes
   are stored under the owner's prefix, the row gets `sha256`, `size`, the sniffed type and `{"blob":…}`, and the
   hub gets `agent:<agentId>:<id>`. The event body is not rewritten (its `size`/`sha256` stay `null`). Promotion does
   not check the quota (the owner did not choose to upload it) but counts toward it. Inbound media is not
   promoted on ingest.
7. **Sweeper.** Hourly over the hubs this process opened (every owner with a started agent). Unbound uploads
   older than 24 h lose `upload:` and their row; blobs without references get `unreferenced_at`; after 7 days the
   object is deleted, then the row (a failed store delete keeps the row for the next sweep). Schema `OWNER_HUB_V2`
   adds two indexes not listed in 16.8: `hub_uploads_unbound` and `hub_blob_refs_ref`.
8. **Integration point for send (phase 3) and control.** `ManagedService.attachments` (`OwnerAttachments`):
   - `reserve(owner, attachmentIds, { agentId } | { roomId })` before the send transaction: checks the caller's own
     unbound uploads (422 `attachment_not_found`, 422 `too_many_attachments` over 10, 413 `attachments_too_large`
     over 30 MiB) and pins each with its `agent:`/`room:` reference. Returns `MessageAttachment[]`
     (`{ attachmentId, name, contentType, size, sha256 }`) for the event body's `attachments`; `render` adds `url`.
   - `writeLedger(ledger, items, eventId)` inside the agent ledger's send transaction (rooms: `writeRoom`). The
     ledger row reuses the upload's `attachmentId`, so the URL the client already has keeps working.
   - `commit(owner, attachmentIds)` after the send committed (`bound_at`, drops `upload:`); `abort(ownerId, ids,
     target)` if it failed. A crash between commit of the send and `commit` leaves the upload unbound: the sweeper
     removes the `upload:` reference after 24 h and the pinned reference keeps the blob.
   - `WebChannel.readAttachment` / `RoomChannel.readAttachment`: `readMedia(ownerId, item)` (cap
     `MAX_MEDIA_BYTES`). Agent outbound media on a web turn: `storeMedia(ownerId, target, media)` then `writeLedger`.
   - Redaction and purge (16.4): `releaseAgent(ownerId, agentId, attachmentIds)` / `releaseRoom(…)` after the
     ledger rows lose their `event_id` or are deleted.
9. **Not done here.** Text over 256 KiB still becomes `truncated: true` (implementation note 13) rather than an
   attachment; the Mau console composer; promotion on ingest.

## Client contract (phase 2, settled with the Mau console)

These answers are normative for clients; the Router and the Mau console (`web/src/api/ledger.ts`) both test them.

1. **Features.** `GET /me` → `limits.features` is a map `{ history, send, cards, attachments, reset, groups, identity,
   matrix }` of booleans. A missing or non-`true` entry means off. Clients use the ledger console only when `history`
   is on. `identity` and `matrix` are added in phases 6 and 7 (sections 18.6 and 19.1). One exception to "missing
   means off": every Router from phase 7 reports `matrix` explicitly, so a client that finds no `matrix` entry is
   talking to an older Router and keeps its Matrix behavior.
2. **Subscribe.** See 8.4 "Subscribe result": per-chat `errors`, `mode` `live | delta | reset`, reload only on
   `snapshot_required`, `ok:false` only for request-level errors.
3. **Latest page.** A request without `before`/`after` returns the newest events, ending at the chat's last event,
   with `newerCursor: null`. If the 1 MiB budget is hit, the oldest events of the page are dropped. A client that
   sees `lastSeq` greater than the last returned `seq` (or a non-null `newerCursor`) catches up with
   `after=<last seq>&generation=<g>` until `newerCursor` is null.
4. **Older pages.** `olderCursor` is the `seq` of the first returned event and is passed unchanged as `before=`,
   which is exclusive (`seq < before`). It is `null` when the page starts at `seq` 1 or is empty. `after=` is also
   exclusive.
5. **Turn placement (console rule).** A turn is rendered once, as a run surface placed right after its first
   loaded input event (`inputEventIds` order). Assistant `message` and `card` events carrying that `turnId` render
   inside the surface instead of as separate bubbles. If no input event is loaded (older page), the surface sits
   at the first such event; an active turn with neither sits at the end of the list.
6. **Turn detail.** `TurnDetail.state` uses the `turn` event vocabulary (`queued`, `running`, `waiting`,
   `completed`, `failed`, `canceled`, `unknown`); the console passes it to the run surface as the task status.
7. **Sending before phase 3.** With `send: false`, the console opens DMs with `POST /chats/dm` and sends into the
   agent's Matrix DM room through Mau's conversations API (a Matrix transaction id per user intent, reused on
   retry). The message returns through Matrix ingress → ledger → `chat.event`. Group chats are read-only.
8. **Uploads (phase 4).** `POST /attachments` requires `Content-Length`; a chunked body is rejected with 411.
   Browsers set the header for `Blob`/`ArrayBuffer` bodies, so clients must not upload a `ReadableStream`.
9. **Credentials.** Browser clients call these routes same-origin with `credentials: "same-origin"`, so an edge
   access gate (for example Cloudflare Access) sees its cookie, and authenticate with the bearer header. The
   socket URL is same-origin `ws(s)://<host>/_agent-router/v1/web/socket?ticket=…`; the browser sends the
   edge cookie on the upgrade.
10. **Sending in phase 3.** With `send: true`, DMs are opened with `POST /chats/dm` (which creates the chat) and messages are
    sent with `POST /chats/:chatId/messages`; no Matrix room is created. See "Implementation notes (phase 3)" for the exact
    shapes. Group chats stay read-only until phase 5.

## Implementation notes (phase 3)

Phase 3 adds the `WebChannel` adapter (`src/channels/web.ts`), switches dispatch and flush to the ledger, and adds the send
and redaction endpoints. These choices fill gaps in the text above or deviate from it:

1. **Flag.** `ServiceConfig.ledgerSend` (`AGENT_LEDGER_SEND=1`), effective only together with `ledgerRead`. It mounts the two
   write routes, sets `GET /me` → `limits.features.send: true`, and makes the agent ledgers authoritative
   (`AgentLedger.authoritative`). Embedders and tests pass `ledgerSend: true` in the `ServiceConfig` given to `createRouter` /
   `ManagedService`. Flag off: the routes are 404, `send` is `false`, and dispatch and flush use the legacy records again;
   Matrix send keeps working.
2. **Authoritative ledger.** With the flag, the dispatcher and flush read the ledger, and ledger writes run in the same
   transaction as their legacy record. A web receipt is strict: a ledger error fails the request (500) and nothing is
   recorded; the client retries with the same key. Every other ledger write keeps the phase 1 savepoint rule: a ledger error
   rolls back only the ledger write, is reported in `ledger.lastError` (`GET /web/debug/ledger`), and the legacy record
   commits. Failing a channel receipt instead would stop its cursor forever on a deterministic error (a Matrix `/sync` batch
   or a Feishu redelivery loop). The legacy record is then carried by the fallbacks of rules 3 and 5 (a receipt without a
   pending input is still dispatched; a settled record is reconciled; an outbox row without a delivery row is still sent),
   so a ledger fault degrades the transcript, never the channel. Without the flag all ledger writes are shadow writes.
3. **Dispatch** reads `ledger_pending_inputs` (`state IN ('queued','starting')`, ordered by `created_at`, then receipt order).
   An input becomes `starting` when the dispatcher takes it, before control handling; after a crash a `starting` input is sent
   again with the same `channel-<input_id>` message id. `received` legacy records without a pending input (reactions, edits,
   redactions, and receipts from before the cutover) are still dispatched, found by one SQL query. A pending input whose legacy
   record has already moved on is reconciled (`started`/`control`/`dropped`), never dispatched again. Resume and quote lookups
   and `input(taskId)` use the ledger indexes (new migration 3: `ledger_pending_inputs(session_key, created_at)`).
4. **Unknown work** is never replayed: when a turn becomes `unknown`, its inputs move to `unknown` (and back to `started` if the
   run is reconciled). The existing "系统不会自动重复执行" notice is the visible marker. The "重新执行 / 不用了" retry card of
   6.2.4 needs card answers over HTTP and moves to phase 4.
5. **Flush** reads `ledger_deliveries` (`status='queued' AND next_at<=now`) and then queued legacy outbox rows that have no
   delivery row (for example rows from before the cutover). A due delivery whose legacy row is no longer queued is resynced,
   not sent. Adapters, chunk checkpoints and dispositions are unchanged.
6. **Web channel.** With the flag, every channel runtime registers `WebChannel` as connection `web` (the id is reserved in
   channel configuration; without the flag the connection is not registered and channel status is unchanged) with the owner's person id as its only owner address. A web message is a normal `ChannelMessage`:
   `externalId = <personId>:<idempotencyKey>`, `sender = <personId>`, `scope: "direct"`, reply target `person:<personId>`,
   and `quoted.messageId = replyTo`. It goes through the same receive → claim → event → pending input → turn path, into the
   owner-main session, so web, Feishu, mail and Matrix owner DMs are one chat with one execution session. Its conversation is
   `(web, digest(ownerId), direct, person:<personId>)` and is the session's `primary`. The event's idempotency key is
   `web:<personId>:<idempotencyKey>` (section 4.1). Web turns have owner admission like other owner DMs.
7. **Web delivery.** A reply, notice or card to a web turn is recorded as its event and gets no `ledger_deliveries` row and no
   `delivery` event. Its legacy outbox row is written `accepted` at once with `externalId = eventId`, so
   `communication/tasks` (`replyMessageIds`) and other legacy views keep working. Deliveries to other channels are unchanged.
   The web channel reports `send: ["text"]` only, so agent media and HTML to a web turn are rejected until phase 4.
8. **Idempotency.** The claim hash is computed from the request (text and `replyTo`), so the same key and body return the
   stored event with `status: "duplicate"` (also after a redaction), and the same key with another body is 409
   `idempotency_key_reused` (Matrix txnId semantics). Two concurrent sends are ordered by their receipt: seq and dispatch order
   follow the commit order.
9. **Validation order.** Chat (`chat_not_found` 404 for foreign or unknown chats, `chat_read_only` 403 for observed chats),
   agent runtime (`agent_channels_not_configured` 409 when the agent has no channel runtime), size (`message_too_large` 413 over
   24 KB UTF-8), attachments (any → 422 `attachments_unsupported`), mentions (a DM accepts only its own agent id, otherwise
   422 `mention_not_member`; they are not stored), empty text (422 `message_empty`), `replyTo` (an event of the same chat,
   otherwise 422 `reply_target_not_found`). A malformed body or key is 400 `invalid_request`.
10. **Rate limits.** Besides the 600/min/IP `/web` limit, sends and redactions share 60 requests per minute per person; the 429
    body is `{ "error": "rate_limit_exceeded", "retryAfterMs": n }`.
11. **`POST /chats/dm`** now creates the owner-main session and the web conversation when they do not exist, and indexes the
    chat (it appears in `GET /chats` with `lastSeq: 0`). It needs no flag.
12. **Redaction (decision 15.1.4e, section 16.4), served early.** The owner may withdraw own web messages; there is no edit.
    Phase 3 serves the section 16.4 endpoint with the `send` flag; phase 4 moves it under `AGENT_LEDGER_CONTROL` (`reset`).
    `POST /chats/:chatId/events/:eventId/redact` with `{ idempotencyKey }` goes through ingress as a `message-redaction`
    (`externalId = <personId>:redact:<idempotencyKey>`) and appends a `redaction` event (`ref_event_id` = target). The target's
    stored body becomes `{ text: "", redacted: true, redactedAt, channel: "web" }` (`channel` keeps the badge; there are no
    attachments before phase 4), and the legacy inbox text is cleared (its hash is kept). The response has `dropped`.
    If no turn has taken the input yet (`queued`), it is `dropped` (legacy reason `redacted_before_start`); a turn already
    started is not canceled. Same key: the stored redaction (`duplicate`); same key for another target: 409
    `idempotency_key_reused`; another key for a redacted target: the existing redaction (`duplicate`). Only `message` events
    the person sent through the web can be redacted: others are 403 `redaction_not_allowed`, unknown ids 404 `event_not_found`.
    History renders the target with `redacted: true` and empty `text`.
13. **Decisions recorded.** Open question 1: the merged owner DM is confirmed (one owner-main session, channel badges from
    `ChatEvent.channel.kind`: `web`, `matrix`, `feishu`, `grove-mail`, …). Open question 4: reset (phase 4) resets the shared
    owner-main session for every owner channel. Open question 6: redaction of own web messages, no edit (above).

Final shapes:

```jsonc
// POST /_agent-router/v1/web/chats/dm%3A<agentId>/messages
{ "idempotencyKey": "01JC9Z7Q4M0000000000000001", "text": "你好", "replyTo": "ev_…" /* optional */ }
// 200
{ "status": "accepted",                       // "duplicate" for a retry with the same key and body
  "event": { "chatId": "dm:<agentId>", "seq": 1, "generation": 1, "eventId": "ev_…", "at": "2026-11-06T04:00:00.000Z",
    "sender": { "type": "person", "id": "prs_…", "name": "alice" }, "channel": { "kind": "web" },
    "idempotencyKey": "01JC9Z7Q4M0000000000000001", "kind": "message", "role": "user", "text": "你好", "replyTo": "ev_…" },
  "addressed": [ { "agentId": "<agentId>", "state": "queued" } ] }
// 409 { "error": "idempotency_key_reused" }

// POST /_agent-router/v1/web/chats/dm%3A<agentId>/events/<eventId>/redact
{ "idempotencyKey": "01JC9Z7Q4M0000000000000002" }
// 200
{ "status": "accepted",                       // or "duplicate"
  "event": { "chatId": "dm:<agentId>", "seq": 6, "generation": 1, "eventId": "ev_…", "at": "…",
    "sender": { "type": "person", "id": "prs_…", "name": "alice" }, "channel": { "kind": "web" },
    "kind": "redaction", "targetEventId": "<eventId>" },
  "dropped": true }                           // the input had not started; false for a duplicate
// History afterwards: { "eventId": "<eventId>", "kind": "message", "role": "user", "text": "", "redacted": true, … }
```

The reply arrives on the socket as `chat.event` frames: `turn` (`queued`, `running`), the assistant `message` with
`final: true`, `channel: { kind: "web" }` and the turn's `turnId`, then `turn` `completed`.


## Implementation notes (phase 4: cards and control)

Phase 4 cards and control are implemented in `src/ledger/control.ts` (`LedgerControl`, one per agent channel runtime) and the web
routes in `src/ledger/web.ts`. Attachments (16.5) are a separate change. These choices fill gaps in section 16 or deviate from it:

1. **Flags.** `ServiceConfig.ledgerCards` (`AGENT_LEDGER_CARDS=1`) and `ServiceConfig.ledgerControl` (`AGENT_LEDGER_CONTROL=1`), each
   effective only with `ledgerSend` (and so `ledgerRead`). They set `GET /me` → `limits.features.cards` / `.reset` and
   `AgentLedger.features`. Off: the routes are 404, and card answers from the chat, the run API and Mau's call endpoint are still
   recorded into the one card record after the Host accepted them (shadow), without first-answer-wins gating.
2. **Schema.** The 16.8 agent-ledger step is migration **4** (`AGENT_LEDGER_V4`), because phase 3 shipped step 3. It also adds
   `ledger_cards.answer_summary` (the label shown by `card.update`) and indexes on `(run_id, call_id)` and
   `ledger_card_tokens(card_id, choice_id)`.
3. **Card body.** `card` events now carry `source`, `native: { method, params }` (the Host call name and input, for
   `describeInteraction` and the console's approval view) and `freeText: true` for every `question` card (including questions
   with options). `kind` is `approval` only for `approval`, `permission`, `*requestApproval` and `session/request_permission` calls;
   `mau-handoff:` cards are `question`. `card.update.answeredBy` is rendered as an `Actor`.
4. **Answer flow** (16.1): scope → `hub_commands` (a `{planned:true}` row is written before the work, so a retry after a crash
   runs again; the final response is stored only for `accepted`) → state → result → plan → `RunObservation.resolve` → commit. Host
   errors: 404 → card `expired`, `stale`; 409 → plan dropped, `stale`; 400/422 → plan dropped, 422 `invalid_answer` with the Host
   code as `detail`; anything else → 503 `card_answer_pending` (`retryAfterMs`), plan kept. The worker re-resolves planned cards
   older than 5 s on each tick. A retry with the key whose planned answer the worker completed returns `accepted`, later ones
   `duplicate`.
5. **One record.** `LedgerControl.record` (run API `runs/:claimId/calls/:callId/result` and Mau's `calls/:callId/result`, surface
   `run-api`), `planChat`/`commitChat` (chat text and buttons, surface `channel`) and `answer` (surface `web`) all plan into and
   close the same `ledger_cards` row. With `cards` on, a later answer is `stale`: the run API answers `{ "status": "stale" }`, a chat
   answer gets the notice "这个问题已在其他入口回答。". The worker closes cards whose call left `pending` without a Router answer
   (`answered`, surface `host`), on deadline (`expired`) and at run end (`canceled`; a planned answer is committed instead).
   **Deviation:** `communication_questions`, `_actions` and `_control_receipts` are still written and read by the chat path (they
   remain its crash receipts); removing them is left for the release after phase 4.
6. **Unknown turns** (6.2.4, with `cards`): a Router-native card (`source: "router"`, callId `router-retry:<turnId>`, run id
   `router:<claimId>`, choices "重新执行" / "不用了") is appended when a turn becomes `unknown`, and sent as a notice with buttons to an
   external origin conversation. Either choice closes the unknown run (`closeUnknown`; 409 `turn_still_running` while the Host run
   still runs). "重新执行" then receives a copy of the original input (`externalId <original>:retry:<turnId>`) whose event has
   `possibleDuplicate: true` and whose pending input has `retry_of`. The owner can also answer in the chat with the exact label or
   the button. Reconciling or closing the run elsewhere cancels the card.
7. **Reset.** `ledger_session_windows` drives execution: the dispatcher sends `contextId = contextFor(sessionKey)`, work submissions
   into a reset ledger session use the window context too, and owner checks (`isOwnerTask`, tool admission, chat control) map
   `<key>.w<n>` back to the session. Turns of earlier windows are never resumed. Events of a turn keep the turn's window. Busy =
   `queued`/`running`/`waiting` turns or `queued` inputs; `cancelActive` cancels them and drops the inputs (reason `reset`).
   `/new`, `/reset`, `新对话` are handled only for owner inputs in the `owner_main` session.
8. **Purge** also accepts `cancelActive` (otherwise 409 `session_busy`, as reset). It restarts `seq` at 1 in the new generation,
   deletes the session's cards and tokens, keeps queued/sending deliveries (unbound from their event), drops queued inputs, clears the
   chat's read markers, and blanks the text of the session's legacy inbox records and settled outbox rows (`communication_media` is
   deleted). Execution records, `communication_results`, Mau memory and Matrix `timeline` copies are kept.
9. **Cancel** works for any non-terminal turn of the chat's session (an `unknown` turn too); `RunObservation.cancel` accepts any
   ledger turn. **Steer** without `host.steer`, or a 4xx from the Host, is `unsupported`; a 5xx is 503 `steer_failed`.
10. **Rate limit.** Card answers and control routes share 60 requests per minute per person (separate from sends).

```jsonc
// POST /_agent-router/v1/web/chats/dm%3A<agentId>/cards/<cardId>/answer
{ "idempotencyKey": "…", "choiceId": "0" }            // or { "text": "…" }, or { "result": … } (host question cards only)
// 200 { "status": "accepted" | "duplicate" | "stale", "card": Card }
// 422 { "error": "invalid_answer", "detail": "structured_answers_required" } | choice_not_found | choice_or_text_required
//     | sensitive_input_requires_native_entry;  503 { "error": "card_answer_pending", "retryAfterMs": 1000 }
// GET  …/cards/<cardId>                                 → Card (live text while a handoff card is pending)
// POST …/turns/<turnId>/cancel {}                       → { "status": "accepted" } | { "status": "already_finished", "state": "canceled" }
// POST …/turns/<turnId>/steer { idempotencyKey, text }  → { "status": "accepted", "event": ChatEvent /* steer: true */ } | { "status": "unsupported" }
// POST …/reset { idempotencyKey, cancelActive? }        → { "window": 2, "event": ChatEvent /* kind "window" */ }
//      409 { "error": "session_busy", "activeTurns": ["…"], "queuedInputs": 0 }
// POST …/purge { idempotencyKey, confirm: "<chatId>", cancelActive? } → { "generation": 2, "purgedEvents": 12, "window": 2 }
//      422 { "error": "purge_confirmation_required" }
```

## Implementation notes (phase 5)

Phase 5 adds native groups: `src/ledger/rooms.ts` (hub rooms, transcript, fan-out, group context, mirror),
`src/ledger/rooms-web.ts` (group commands), `src/ledger/rooms-fanout.ts` (worker), `src/channels/room.ts` (`RoomChannel`)
and `src/ledger/rooms-import.ts` (Matrix import). These choices fill gaps in section 17 or deviate from it:

1. **Flag.** `ServiceConfig.ledgerGroups` (`AGENT_LEDGER_GROUPS=1`), effective with `ledgerRead` and `ledgerSend`. It sets
   `limits.features.groups`, accepts group commands and room sends, and starts the fan-out worker. Flag off: room chats stay
   listed and readable (`readOnly: true`), `POST /groups…` and room sends are 403 `feature_disabled`, and the `room` connection is
   not registered in the channel runtimes (as `web` without `ledgerSend`), so channel status and dispatch are unchanged. A room
   frozen by the import stays frozen with the flag off. The flag is independent of `cards` and `reset`.
2. **Schema.** The section 17.8 tables and indexes (plus `hub_room_events(room_id, turn_id)`) are one step with its own counter
   (`meta.hub_rooms_schema_version = 1`) instead of `OWNER_HUB_V3`, so it does not depend on the order of the phase 4 step.
3. **Hub delegation.** `OwnerHub` routes `room:` chat ids to `HubRooms` for summary, history, read markers, turns and socket
   subscribe/replay. Rooms are indexed in `hub_chats` (`kind 'group'`, `agent_id NULL`). An agent's `room` session is not a chat:
   its publication mirrors `turn`, `card`, `card.update` and its room replies into the room, in ledger order, under the 17.4 keys,
   so the room shows `turn queued → running → message → completed` as a DM does. `chat.stream` frames of a room session use the
   room chat id.
4. **Sessions.** `RoomChannel` (connection `room`, reserved in channel configuration, owner address = the owner id) creates
   `ledger_sessions(kind='room', room_id)`. The session key keeps the legacy formula; `ChannelAdapter.sessionConnection` lets an
   imported room (`threadId` = Matrix room id) use the agent's Matrix connection id in it, so the key, and the Host session, are
   the ones its Matrix group session already had.
5. **Group context.** `ChannelAdapter.turnContext` returns the prefix and a `commit`; the dispatcher prepends it to the model input
   and commits after the turn start. The cursor is in the hub file, so it moves right after (not in) the agent transaction; a
   crash in between repeats the context once. Times use the server time zone; the owner is named "主人".
6. **Send.** Validation order as in phase 3 (8.3), plus `mention_not_member`. Same key and body: `duplicate`; same key, other
   body: 409. `addressed` lists every member agent with `queued | delivered | failed | not_addressed`.
7. **Commands.** Create is idempotent through `hub_commands` (`group:<key>`); 1–64 characters (400 `invalid_request` otherwise),
   1–20 unique agents, 422 `agent_not_found`, 429 `room_limit_reached` (100 rooms, archived ones included). Add/remove are
   idempotent without a key; more than 20 agents is 422 `too_many_members`. Member events: `add` per agent at creation, `rename`,
   `remove` (sender `system` when the agent is deleted).
8. **Not yet.** Room reset (17.5), card answers from a room chat and media in rooms are not implemented: the phase 4 card and
   control routes resolve only `dm:`/`obs:` chats (404 `chat_not_found` for a room chat), and media waits for the blob store.
   `RoomChannel` sends text and HTML only (`channel_content_unsupported` otherwise).
9. **Import.** `npm run ledger:import-rooms -- (--owner <ownerId> | --all) [--dry-run] [--state <dir>]` (`import-groups` is an
   alias). It runs with the Router service **stopped** and Synapse running, like the backfill: the agent stores are leased, so a
   running service cannot share them. Gap filling reads the agents' `timeline` mirrors and Synapse `/messages` (AS token) back to
   the first known `matrix:<event_id>`. The freeze record is `matrix_room_migrations[<matrixRoomId>] = { roomId, at,
   noticeEventId }`; the notice is sent once (transaction id of 17.6, and `noticeEventId` on rerun). Each agent's cursor starts at
   the room's last seq, because its Matrix session already holds that history. After the restart `MatrixChannel` claims new
   messages of the room as `ignored` (`room_migrated`) through `ChannelAdapter.ignored`.

Final shapes:

```jsonc
// POST /_agent-router/v1/web/groups
{ "idempotencyKey": "01JC…", "title": "周报小组", "agentIds": ["<agentId-1>", "<agentId-2>"] }
// 201
{ "chatId": "room:rm_01JC…", "kind": "group", "title": "周报小组", "agentIds": ["<agentId-1>", "<agentId-2>"], "readOnly": false,
  "lastSeq": 2, "generation": 1, "readSeq": 0, "unread": 0, "lastEvent": null, "activeTurns": 0, "pendingCards": 0, "updatedAt": "…",
  "members": [ { "type": "person", "id": "prs_…", "name": "alice" }, { "type": "agent", "id": "<agentId-1>", "name": "helper" }, … ] }

// POST /_agent-router/v1/web/chats/room%3Arm_01JC…/messages
{ "idempotencyKey": "01JC…", "text": "@helper 帮我查一下", "mentions": { "agentIds": ["<agentId-1>"], "all": false } }
// 200
{ "status": "accepted", "event": { "chatId": "room:rm_01JC…", "seq": 3, "kind": "message", "role": "user", "text": "@helper 帮我查一下",
    "mentions": { "agentIds": ["<agentId-1>"], "all": false }, "channel": { "kind": "web" }, "idempotencyKey": "01JC…", … },
  "addressed": [ { "agentId": "<agentId-1>", "state": "queued" }, { "agentId": "<agentId-2>", "state": "not_addressed" } ] }
// The reply: { "kind": "message", "role": "assistant", "sender": { "type": "agent", … }, "agentId": "<agentId-1>",
//              "turnId": "…", "replyTo": "<origin eventId>", "final": true, "text": "…" }
```

## Implementation notes (phase 6: identities and pairing)

Phase 6 is split. This part covers persons, owner resolution and pairing (`src/ledger/identity.ts`, `identity-web.ts`).
`CloudflareAccessAuthenticator` (18.2, 18.3, `src/auth/edge-identity.ts`) shipped separately, before this part; an edge login
links its `cloudflare-access` identity (`verifiedBy: "login"`, service tokens `"config"`). These choices fill gaps in the text
above or deviate from it:

1. **Flag.** `ServiceConfig.ledgerIdentity` (`AGENT_LEDGER_IDENTITY=1`). It enables owner resolution by person and `/link`
   in every channel runtime, and, together with `ledgerRead`, the identity routes and `GET /me` → `limits.features.identity:
   true`. Flag off: the routes are 404, `identity` is `false`, owner decisions use the configured `ownerAddresses` only, and
   `/link` from an unknown sender is ignored as `sender_not_allowed` without a reply. Embedders pass
   `{ identity: service.identity }` to `createChannelRuntime`.
2. **Owner check.** `CommunicationCore.isOwner(connection, message)` = configured `ownerAddresses` (kept for one release, and
   still seeded as `config` identities at every start) or `resolve(provider, namespace, sender) === personId(agent.owner)`.
   Feishu also resolves `("feishu-union", tenant_key, union_id)` from the raw event, so a person paired through one Mau Feishu
   app is recognised through another. Resolutions are cached until the next link or revocation; a registry error falls back
   to the configured addresses and never fails a receipt. `isOwnerInput`/`isOwnerTask` honor a person-resolved owner only in
   owner-main: earlier peer inputs of a sender that became the owner keep peer rights. Its first owner message gets a new
   owner-main conversation (`thread_id` suffixed `owner-main`), so the peer conversation does not move. Weixin keeps
   namespace `''` as seeded in phase 1 (section 18.1 names the account id).
3. **Ingress hook.** In `receive`, after the duplicate check and before the sender check, for every non-web connection and
   messages without event, action or attachments. Direct: the reply is a legacy outbox notice on the message's own route.
   It has no `ledger_deliveries` row (that table requires a conversation, and strangers get none, note 4 of phases 1–2);
   the authoritative flush sends it through the outbox fallback. Group: ignored without a reply, the code stays pending.
   Both: the claim is `ignored`/`pairing`, no conversation, session, event or turn, and the legacy inbox record keeps the
   hash but stores `/link ********` and no `native`/`quoted`. A registry or hub error replies "暂时无法关联，请稍后再试。".
4. **Attempts.** Only pending codes of the receiving agent's owner match, so pairing only links the owner's own identities;
   other senders keep the visitor flow (section 9). Order: lockout, code, link. A wrong, expired, reused or foreign code is a
   failure; the fifth failure within an hour replies with the lockout text and locks for one hour. An identity of another
   person: "此账号已关联到其他用户。", not a failure, and the code stays pending. Success clears the failures. A redelivered
   `/link` whose code was consumed by the same identity replies success again. A revoked identity can be paired again.
5. **Mail.** Pairing over `grove-mail` needs the connection option `pairing: true` **and** `native.senderVerified === true`;
   no adapter sets that verdict yet (open question 4), so mail pairing stays off in practice. Otherwise "无法验证发件人，未关联。".
   The command may stand alone in the body, or in the subject with an empty body.
6. **Schema.** `REGISTRY_V2` adds `last_seen_at` (skipped if the column already exists). The hub tables of 18.6 plus
   `hub_pairing_codes.code_id` (a random id for listing and cancelling; codes are stored hashed only) are versioned under
   their own meta row `hub_identity_schema_version`, independent of the phase 4 and 5 hub steps. `last_seen_at` is written
   at most once a minute per identity for person-resolved owner messages.
7. **Routes** (under `/_agent-router/v1/web`, owner-scoped):

```jsonc
// GET /identities
{ "data": [ { "identityId": "idn_…", "personId": "prs_…", "provider": "feishu", "namespace": "cli_…", "subject": "ou_…",
  "verifiedBy": "pairing", "createdAt": "…", "lastSeenAt": "…" | null, "removable": true },
  { "identityId": "idn_…", "provider": "matrix", "verifiedBy": "config", "removable": false, "fixed": "identity_from_config", … } ] }
// DELETE /identities/:identityId → 204 | 404 identity_not_found | 409 identity_from_config | 409 identity_in_use
//   (in use: the `cloudflare-access` identity whose subject is the edge principal's `email`, i.e. the login of this
//   request; bearer principals have no email, so nothing is in use for them. Another `cloudflare-access` identity can be
//   removed, but while `edgeIdentity.owners` still maps its email the next edge login links it again.)
// POST /identities/pairing-codes {} → 201
{ "id": "pc_…", "code": "7KQ4-M2XD", "expiresAt": "…", "instructions": "在要关联的渠道里私聊你的任一 Agent，发送：/link 7KQ4-M2XD" }
//   429 { "error": "pairing_codes_pending_limit" }
// GET /identities/pairing-codes → { "data": [ { "id": "pc_…", "createdAt": "…", "expiresAt": "…" } ] }  (pending, never the code)
// DELETE /identities/pairing-codes/:codeId → 204 | 404 pairing_code_not_found
```
