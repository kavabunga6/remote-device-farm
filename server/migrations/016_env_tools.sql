-- Environment tools: audit events can carry a short, non-secret detail (the operation name).
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS detail text CHECK (detail IS NULL OR length(detail) <= 80);
