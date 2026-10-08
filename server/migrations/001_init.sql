CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  subject text NOT NULL,
  username text NOT NULL,
  display_name text NOT NULL,
  password_hash text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS browser_sessions_expires_idx ON browser_sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('personal', 'system')),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal' AND owner_user_id IS NOT NULL) OR (kind = 'system' AND owner_user_id IS NULL))
);
CREATE INDEX IF NOT EXISTS api_tokens_owner_idx ON api_tokens(owner_user_id);

CREATE TABLE IF NOT EXISTS oidc_flows (
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS hosts (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  slots integer NOT NULL DEFAULT 0 CHECK (slots BETWEEN 0 AND 256),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_credentials (
  host_id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  id text PRIMARY KEY,
  name text NOT NULL,
  android_version text NOT NULL,
  image text NOT NULL,
  cpu integer NOT NULL CHECK (cpu > 0),
  memory_mb integer NOT NULL CHECK (memory_mb > 0),
  disk_gb integer NOT NULL CHECK (disk_gb > 0),
  emulator_params text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  host_id text NOT NULL REFERENCES hosts(id),
  profile_id text NOT NULL REFERENCES profiles(id),
  state text NOT NULL CHECK (state IN ('starting','running','stopping','stopped','failed')),
  container_id text,
  orientation text NOT NULL DEFAULT 'portrait' CHECK (orientation IN ('portrait','landscape')),
  audio_enabled boolean NOT NULL DEFAULT false,
  network_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  error text
);
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_host_state_idx ON sessions(host_id, state);

CREATE TABLE IF NOT EXISTS host_slots (
  host_id text NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  slot_index integer NOT NULL CHECK (slot_index >= 0),
  session_id uuid UNIQUE,
  PRIMARY KEY (host_id, slot_index)
);

CREATE TABLE IF NOT EXISTS adb_access_tokens (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS adb_access_tokens_expires_idx ON adb_access_tokens(expires_at);

INSERT INTO profiles (id,name,android_version,image,cpu,memory_mb,disk_gb)
VALUES
  ('android-30','Android 11 · Pixel','11 (API 30)','us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2',2,3072,8)
ON CONFLICT (id) DO NOTHING;
