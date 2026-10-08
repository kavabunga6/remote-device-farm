-- Preserve the requested configuration across queue assignment and personal presets.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS launch_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(launch_options) = 'object');
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS launch_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(launch_options) = 'object');
ALTER TABLE user_profile_presets ADD COLUMN IF NOT EXISTS launch_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(launch_options) = 'object');
-- Preserve exact MiB choices alongside the GiB compatibility fields.
ALTER TABLE sessions ALTER COLUMN launch_sdcard_gb TYPE numeric USING launch_sdcard_gb::numeric;
ALTER TABLE queue_entries ALTER COLUMN sdcard_gb TYPE numeric USING sdcard_gb::numeric;
ALTER TABLE user_profile_presets ALTER COLUMN sdcard_gb TYPE numeric USING sdcard_gb::numeric;
UPDATE sessions SET launch_options=jsonb_strip_nulls(jsonb_build_object('diskGb',launch_disk_gb,'sdCardMb',CASE WHEN launch_disk_gb IS NULL AND launch_sdcard_gb IS NULL THEN NULL ELSE COALESCE(launch_sdcard_gb,0)*1024 END)) WHERE launch_options='{}'::jsonb;
UPDATE queue_entries SET launch_options=jsonb_strip_nulls(jsonb_build_object('diskGb',disk_gb,'sdCardMb',CASE WHEN sdcard_gb IS NULL THEN NULL ELSE sdcard_gb*1024 END)) WHERE launch_options='{}'::jsonb;
UPDATE user_profile_presets SET launch_options=jsonb_strip_nulls(jsonb_build_object('diskGb',disk_gb,'sdCardMb',CASE WHEN sdcard_gb IS NULL THEN NULL ELSE sdcard_gb*1024 END)) WHERE launch_options='{}'::jsonb;
-- A development-branch database may already have JSON snapshots but no GiB columns.
UPDATE sessions SET launch_disk_gb=COALESCE(launch_disk_gb,(launch_options->>'diskGb')::integer),launch_sdcard_gb=COALESCE(launch_sdcard_gb,(launch_options->>'sdCardMb')::numeric/1024);
UPDATE queue_entries SET disk_gb=COALESCE(disk_gb,(launch_options->>'diskGb')::integer),sdcard_gb=COALESCE(sdcard_gb,(launch_options->>'sdCardMb')::numeric/1024);
UPDATE user_profile_presets SET disk_gb=COALESCE(disk_gb,(launch_options->>'diskGb')::integer),sdcard_gb=COALESCE(sdcard_gb,(launch_options->>'sdCardMb')::numeric/1024);
ALTER TABLE user_profile_presets DROP CONSTRAINT IF EXISTS user_profile_presets_owner_user_id_profile_id_gpu_mode_key;
CREATE UNIQUE INDEX IF NOT EXISTS user_profile_presets_launch_variant ON user_profile_presets(owner_user_id,profile_id,gpu_mode,launch_options);
