-- Session sharing: one-time links (stored as SHA-256 hashes) and the per-user grants they create.
CREATE TABLE IF NOT EXISTS session_shares (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('view','control')),
  max_recipients smallint NOT NULL DEFAULT 1 CHECK (max_recipients BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS session_shares_session_idx ON session_shares(session_id);

CREATE TABLE IF NOT EXISTS session_share_grants (
  id uuid PRIMARY KEY,
  share_id uuid NOT NULL REFERENCES session_shares(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('view','control')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS session_share_grants_lookup_idx ON session_share_grants(session_id, user_id);
