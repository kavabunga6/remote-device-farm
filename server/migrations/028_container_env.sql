-- Extra environment variables for the emulator container, kept apart from the emulator's own command-line
-- arguments (emulator_params). Both are data: the farm never accepts Docker run options from profiles.
ALTER TABLE profiles ADD COLUMN container_env jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(container_env) = 'object');
