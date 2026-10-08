ALTER TABLE sessions ADD COLUMN lease_ttl_seconds integer;
ALTER TABLE sessions ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE sessions ADD CONSTRAINT session_lease_valid CHECK (
  (lease_ttl_seconds IS NULL AND lease_expires_at IS NULL) OR
  (lease_ttl_seconds IS NOT NULL AND lease_ttl_seconds BETWEEN 30 AND 3600 AND lease_expires_at IS NOT NULL)
);
CREATE INDEX sessions_lease_expiry ON sessions(lease_expires_at)
  WHERE state IN ('starting','running') AND lease_expires_at IS NOT NULL;
