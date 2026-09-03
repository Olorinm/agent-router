ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_message_idempotency_unique;

UPDATE tasks
   SET idempotency_scope = (
     idempotency_scope::jsonb || to_jsonb(agent_id::text)
   )::text
 WHERE idempotency_scope::jsonb ->> 0 = 'federation'
   AND jsonb_array_length(idempotency_scope::jsonb) = 2;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_message_idempotency_unique
  UNIQUE (idempotency_scope, message_id);

ALTER TABLE task_bindings
  DROP CONSTRAINT IF EXISTS task_bindings_delivery_state_check;

UPDATE task_bindings
   SET delivery_state = 'awaiting_result'
 WHERE delivery_state = 'awaiting_push';

ALTER TABLE task_bindings
  ADD COLUMN callback_token_hash text,
  ADD CONSTRAINT task_bindings_delivery_state_check CHECK (
    delivery_state IN ('queued', 'delivering', 'awaiting_result', 'delivered', 'failed', 'canceled')
  );

DROP INDEX IF EXISTS task_bindings_federation_poll_idx;

CREATE INDEX task_bindings_remote_poll_idx
  ON task_bindings(next_poll_at)
  WHERE delivery_state = 'awaiting_result';

ALTER TABLE delivery_attempts
  DROP CONSTRAINT IF EXISTS delivery_attempts_outcome_check,
  ADD CONSTRAINT delivery_attempts_outcome_check CHECK (
    outcome IN ('started', 'accepted', 'delivered', 'retrying', 'failed', 'skipped')
  );
