-- Retain identity and history without allowing the provider to recreate the account.
ALTER TABLE users ADD COLUMN removed_at timestamptz;
