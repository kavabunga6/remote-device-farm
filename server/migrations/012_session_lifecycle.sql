-- Session lifecycle: a user-visible label and the time of the last user action (for idle release).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS label text CHECK (label IS NULL OR char_length(label) <= 60),
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();
