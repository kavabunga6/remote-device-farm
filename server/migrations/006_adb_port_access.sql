CREATE TABLE adb_port_access (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  port integer NOT NULL UNIQUE CHECK (port BETWEEN 1024 AND 65535),
  public_key text NOT NULL,
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  expires_at timestamptz NOT NULL
);
CREATE INDEX adb_port_access_expires_idx ON adb_port_access(expires_at);
