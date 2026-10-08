CREATE TABLE user_adb_public_keys (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  public_key text NOT NULL,
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, fingerprint)
);
CREATE INDEX user_adb_public_keys_owner_idx ON user_adb_public_keys(owner_user_id, created_at DESC);

-- The uploaded key is selected when a session is created. The broker checks
-- its signature; the agent's separate control key remains inside the emulator.
ALTER TABLE sessions ADD COLUMN adb_key_id uuid REFERENCES user_adb_public_keys(id) ON DELETE RESTRICT;
