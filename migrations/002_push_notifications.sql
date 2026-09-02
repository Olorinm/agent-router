CREATE TABLE IF NOT EXISTS task_push_notification_configs (
  tenant text NOT NULL DEFAULT '',
  owner_principal_id text NOT NULL REFERENCES principals(id),
  task_id text NOT NULL,
  config_id text NOT NULL,
  wire_version text NOT NULL,
  config_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, owner_principal_id, task_id, config_id)
);

CREATE INDEX IF NOT EXISTS task_push_configs_task_idx
  ON task_push_notification_configs(tenant, owner_principal_id, task_id, updated_at);
