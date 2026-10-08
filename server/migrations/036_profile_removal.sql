-- Keep the profile identity for rental history, queue records and team allowlists.
-- Removing the last allowlist row would otherwise grant the team access to every profile.
ALTER TABLE profiles ADD COLUMN removed_at timestamptz;
ALTER TABLE profiles ADD CONSTRAINT removed_profiles_disabled CHECK (removed_at IS NULL OR enabled=false);
