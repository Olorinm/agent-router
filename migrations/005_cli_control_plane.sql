CREATE TABLE enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  label text NOT NULL DEFAULT '',
  address text,
  endpoint_origin text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'revoked')),
  created_by_principal_id text NOT NULL REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX enrollment_tokens_active_idx
  ON enrollment_tokens(expires_at)
  WHERE status = 'active';

ALTER TABLE credentials
  ADD COLUMN label text NOT NULL DEFAULT '',
  ADD COLUMN expires_at timestamptz;

CREATE INDEX credentials_principal_active_idx
  ON credentials(principal_id, created_at DESC)
  WHERE status = 'active';
