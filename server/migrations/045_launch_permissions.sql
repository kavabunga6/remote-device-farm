CREATE TABLE launch_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  allow_launch_overrides boolean NOT NULL DEFAULT false
);
INSERT INTO launch_settings (id) VALUES (true);
ALTER TABLE profiles ADD COLUMN allow_launch_overrides boolean;

-- Device selection replaces saved presets; rental history is retained.
DROP TABLE IF EXISTS user_profile_presets;
