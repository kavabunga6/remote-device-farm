ALTER TABLE profiles ADD COLUMN IF NOT EXISTS recommended boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_profile_presets (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  gpu_mode text NOT NULL CHECK (gpu_mode IN ('software', 'nvidia')),
  is_favorite boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, profile_id, gpu_mode)
);
