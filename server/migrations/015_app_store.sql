-- Per-user app library. Files live on disk under APP_STORE_DIR/<user id>/<app id>.apk.
CREATE TABLE stored_apps (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 240),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  package_name text CHECK (package_name IS NULL OR char_length(package_name) <= 255),
  version_name text CHECK (version_name IS NULL OR char_length(version_name) <= 100),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, sha256)
);
CREATE INDEX stored_apps_owner_idx ON stored_apps(owner_user_id, uploaded_at DESC);
