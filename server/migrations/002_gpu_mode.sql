ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gpu_mode text NOT NULL DEFAULT 'software'
  CHECK (gpu_mode IN ('software', 'nvidia'));
