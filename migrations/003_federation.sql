ALTER TABLE principals
  DROP CONSTRAINT IF EXISTS principals_kind_check,
  ADD CONSTRAINT principals_kind_check CHECK (kind IN ('human', 'agent', 'operator', 'federation'));

ALTER TABLE agents
  ADD COLUMN target_kind text NOT NULL DEFAULT 'local',
  ADD COLUMN origin_domain text,
  ADD COLUMN remote_card_expires_at timestamptz,
  ADD CONSTRAINT agents_target_kind_check CHECK (target_kind IN ('local', 'federated')),
  ADD CONSTRAINT agents_origin_domain_check CHECK (
    (target_kind = 'local' AND origin_domain IS NULL) OR
    (target_kind = 'federated' AND origin_domain IS NOT NULL)
  );

CREATE INDEX agents_federated_expiry_idx
  ON agents(remote_card_expires_at)
  WHERE target_kind = 'federated';

ALTER TABLE tasks
  ADD COLUMN idempotency_scope text;

UPDATE tasks
   SET idempotency_scope = jsonb_build_array(
     'local', tenant, owner_principal_id, agent_id::text
   )::text;

ALTER TABLE tasks
  ALTER COLUMN idempotency_scope SET NOT NULL,
  ADD CONSTRAINT tasks_message_idempotency_unique
  UNIQUE (idempotency_scope, message_id);

ALTER TABLE task_bindings
  DROP CONSTRAINT IF EXISTS task_bindings_delivery_state_check,
  ADD COLUMN remote_domain text,
  ADD COLUMN remote_subject text,
  ADD COLUMN next_poll_at timestamptz,
  ADD COLUMN callback_received_at timestamptz,
  ADD CONSTRAINT task_bindings_delivery_state_check CHECK (
    delivery_state IN ('queued', 'delivering', 'awaiting_push', 'delivered', 'failed', 'canceled')
  );

CREATE INDEX task_bindings_federation_callback_idx
  ON task_bindings(remote_domain, router_task_id)
  WHERE remote_domain IS NOT NULL;

CREATE INDEX task_bindings_federation_poll_idx
  ON task_bindings(next_poll_at)
  WHERE delivery_state = 'awaiting_push';

CREATE TABLE federation_domains (
  domain text PRIMARY KEY CHECK (domain = lower(domain)),
  status text NOT NULL CHECK (status IN ('allowed', 'blocked')),
  updated_by text NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE federation_jti (
  issuer text NOT NULL,
  jti text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, jti)
);

CREATE INDEX federation_jti_expiry_idx ON federation_jti(expires_at);
