ALTER TABLE service_logs ADD COLUMN message text NOT NULL DEFAULT '' CHECK (length(message) <= 4096);
CREATE INDEX service_logs_session_idx ON service_logs(session_id,id);
