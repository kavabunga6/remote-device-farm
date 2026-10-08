-- Profile container variables are stored encrypted and never shown again; the key either comes from SECRETS_KEY or is
-- generated once and kept here. Docker-level options are an allowlisted JSON document validated by broker and agent.
CREATE TABLE IF NOT EXISTS app_secrets (
  name text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS docker_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(docker_options) = 'object');
