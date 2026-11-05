/** ADR 0005 section 4. Each constant is one additive migration step; never edit a shipped step. */
export const AGENT_LEDGER_V1 = `
CREATE TABLE ledger_conversations(
  conversation_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, channel TEXT NOT NULL, account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('direct','group','channel')), peer_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL, person_id TEXT,
  reply_route TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, last_inbound_at INTEGER,
  UNIQUE(channel, account_id, kind, peer_id, parent_id, thread_id));
CREATE INDEX ledger_conversations_session ON ledger_conversations(session_key);
CREATE TABLE ledger_sessions(
  session_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('owner_main','peer','group','room','schedule','work','delegation')),
  label TEXT NOT NULL, room_id TEXT, window INTEGER NOT NULL DEFAULT 1, last_seq INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1, published_seq INTEGER NOT NULL DEFAULT 0,
  title TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE ledger_session_windows(
  session_key TEXT NOT NULL, window INTEGER NOT NULL, context_id TEXT NOT NULL UNIQUE,
  opened_at INTEGER NOT NULL, closed_at INTEGER, reason TEXT, PRIMARY KEY(session_key, window));
CREATE TABLE ledger_session_conversations(
  session_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('primary','participant','related')), last_inbound_at INTEGER,
  PRIMARY KEY(session_key, conversation_id));
CREATE TABLE ledger_events(
  session_key TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, window INTEGER NOT NULL,
  kind TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  sender_type TEXT NOT NULL CHECK(sender_type IN ('person','agent','external','system')), sender_id TEXT NOT NULL,
  conversation_id TEXT, turn_id TEXT, ref_event_id TEXT, idempotency_key TEXT, created_at INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(session_key, seq), UNIQUE(session_key, idempotency_key));
CREATE INDEX ledger_events_turn ON ledger_events(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX ledger_events_ref ON ledger_events(ref_event_id) WHERE ref_event_id IS NOT NULL;
CREATE TABLE ledger_ingress(
  connection_id TEXT NOT NULL, external_id TEXT NOT NULL, input_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','ignored','tombstone')), reason TEXT, event_id TEXT, conversation_id TEXT,
  received_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY(connection_id, external_id));
CREATE TABLE ledger_pending_inputs(
  input_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','starting','started','control','dropped','unknown')),
  turn_id TEXT, retry_of TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ledger_pending_due ON ledger_pending_inputs(state, created_at) WHERE state IN ('queued','starting');
CREATE TABLE ledger_turns(
  turn_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, window INTEGER NOT NULL,
  admission TEXT NOT NULL CHECK(admission IN ('owner','peer','group','schedule','work','delegation')),
  origin_conversation_id TEXT, origin_event_id TEXT, reply_route TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','completed','failed','canceled','unknown')),
  final_event_id TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX ledger_turns_session ON ledger_turns(session_key, created_at);
CREATE TABLE ledger_cards(
  card_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, run_id TEXT NOT NULL, claim_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  session_key TEXT NOT NULL, event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('question','approval','connector_approval','sensitive')),
  status TEXT NOT NULL CHECK(status IN ('pending','answered','approved','rejected','expired','canceled')),
  deadline_at INTEGER, answered_by TEXT, answer_key TEXT UNIQUE, result TEXT, updated_at INTEGER NOT NULL);
CREATE INDEX ledger_cards_open ON ledger_cards(session_key) WHERE status = 'pending';
CREATE TABLE ledger_card_tokens(token TEXT PRIMARY KEY, card_id TEXT NOT NULL, choice_id TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE ledger_deliveries(
  delivery_id TEXT PRIMARY KEY, event_id TEXT, conversation_id TEXT NOT NULL, connection_id TEXT NOT NULL, route TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('reply','notice','card','content','activity','mirror')),
  status TEXT NOT NULL CHECK(status IN ('created','queued','sending','sent','suppressed','rejected','unknown','replied')),
  content TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
  platform_message_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ledger_deliveries_due ON ledger_deliveries(next_at) WHERE status = 'queued';
CREATE INDEX ledger_deliveries_event ON ledger_deliveries(event_id);
CREATE TABLE ledger_platform_messages(
  connection_id TEXT NOT NULL, platform_message_id TEXT NOT NULL, event_id TEXT NOT NULL, part INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connection_id, platform_message_id));
CREATE INDEX ledger_platform_by_event ON ledger_platform_messages(event_id);
CREATE TABLE ledger_attachments(
  attachment_id TEXT PRIMARY KEY, event_id TEXT, name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER,
  sha256 TEXT, locator TEXT NOT NULL, created_at INTEGER NOT NULL);`;

export const OWNER_HUB_V1 = `
CREATE TABLE hub_chats(
  chat_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dm','group','observed')),
  agent_id TEXT, session_key TEXT, room_id TEXT, title TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1, last_event TEXT, active_turns INTEGER NOT NULL DEFAULT 0,
  pending_cards INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE INDEX hub_chats_recent ON hub_chats(archived, updated_at DESC);
CREATE TABLE hub_read_markers(chat_id TEXT NOT NULL, person_id TEXT NOT NULL, read_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, person_id));
CREATE TABLE hub_rooms(
  room_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  matrix_room_id TEXT UNIQUE, last_seq INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE hub_room_members(
  room_id TEXT NOT NULL, member_type TEXT NOT NULL CHECK(member_type IN ('person','agent')), member_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','agent')), joined_at INTEGER NOT NULL, left_at INTEGER,
  PRIMARY KEY(room_id, member_type, member_id));
CREATE TABLE hub_room_events(
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, role TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT NOT NULL,
  turn_id TEXT, ref_event_id TEXT, idempotency_key TEXT, created_at INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(room_id, seq), UNIQUE(room_id, idempotency_key));
CREATE TABLE hub_fanout(
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(room_id, seq, agent_id));
CREATE TABLE hub_commands(person_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(person_id, idempotency_key));
CREATE TABLE hub_pairing_codes(code_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER, consumed_identity TEXT);
CREATE TABLE hub_blobs(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL);`;

export const REGISTRY_V1 = `
CREATE TABLE reg_persons(person_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE reg_person_identities(
  identity_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, provider TEXT NOT NULL, namespace TEXT NOT NULL, subject TEXT NOT NULL,
  verified_by TEXT NOT NULL CHECK(verified_by IN ('login','config','pairing','admin')),
  created_at INTEGER NOT NULL, revoked_at INTEGER, UNIQUE(provider, namespace, subject));
CREATE INDEX reg_identities_person ON reg_person_identities(person_id);`;
