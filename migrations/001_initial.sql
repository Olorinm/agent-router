CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principals (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('human', 'agent', 'operator')),
  display_name text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL UNIQUE CHECK (address = lower(address)),
  display_name text NOT NULL,
  description text NOT NULL,
  source_agent_card jsonb NOT NULL,
  endpoint_auth_ciphertext text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  owner_principal_id text NOT NULL REFERENCES principals(id),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id text NOT NULL REFERENCES principals(id),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS tasks (
  tenant text NOT NULL DEFAULT '',
  owner_principal_id text NOT NULL REFERENCES principals(id),
  task_id text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id),
  message_id text NOT NULL,
  state integer NOT NULL,
  task jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_principal_id, task_id)
);

CREATE INDEX IF NOT EXISTS tasks_agent_updated_idx ON tasks(agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_owner_updated_idx ON tasks(owner_principal_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant text NOT NULL DEFAULT '',
  owner_principal_id text NOT NULL REFERENCES principals(id),
  router_task_id text NOT NULL,
  message_id text NOT NULL,
  sender_address text NOT NULL,
  recipient_address text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, owner_principal_id, recipient_address, message_id)
);

CREATE TABLE IF NOT EXISTS task_events (
  id bigserial PRIMARY KEY,
  tenant text NOT NULL DEFAULT '',
  owner_principal_id text NOT NULL REFERENCES principals(id),
  task_id text NOT NULL,
  state integer NOT NULL,
  status jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_events_task_idx
  ON task_events(tenant, owner_principal_id, task_id, id);

CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('deliver', 'cancel')),
  aggregate_key text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_ready_idx
  ON outbox(available_at, id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS task_bindings (
  tenant text NOT NULL DEFAULT '',
  owner_principal_id text NOT NULL REFERENCES principals(id),
  router_task_id text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id),
  remote_task_id text,
  remote_context_id text,
  delivery_state text NOT NULL CHECK (delivery_state IN ('queued', 'delivering', 'delivered', 'failed', 'canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_principal_id, router_task_id)
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id bigserial PRIMARY KEY,
  tenant text NOT NULL DEFAULT '',
  owner_principal_id text NOT NULL REFERENCES principals(id),
  router_task_id text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id),
  attempt integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('started', 'delivered', 'retrying', 'failed', 'skipped')),
  error_code text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS delivery_attempts_task_idx
  ON delivery_attempts(tenant, owner_principal_id, router_task_id, attempt);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id),
  action text NOT NULL,
  target text NOT NULL,
  outcome text NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
