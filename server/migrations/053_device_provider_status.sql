ALTER TABLE hosts ADD COLUMN IF NOT EXISTS provider_status jsonb NOT NULL DEFAULT '[]';
