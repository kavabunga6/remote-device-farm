CREATE TABLE user_adb_keys (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A saved user key authorizes its broker port for the lifetime of a session.
-- Existing one-hour per-session leases are preserved without modification.
ALTER TABLE adb_port_access ALTER COLUMN expires_at DROP NOT NULL;
