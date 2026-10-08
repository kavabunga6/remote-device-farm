-- Stable queue requests for CI retries, polling and ADB-key selection.
ALTER TABLE queue_entries
  ADD COLUMN adb_key_id uuid,
  ADD COLUMN request_key text,
  ADD COLUMN request_fingerprint text,
  ADD COLUMN lease_ttl_seconds integer CHECK (lease_ttl_seconds BETWEEN 30 AND 3600),
  ADD COLUMN error_code text;
-- Existing waiting requests used the owner's default at assignment time. Capture it on upgrade.
UPDATE queue_entries q SET adb_key_id=p.default_adb_key_id
FROM user_preferences p WHERE p.user_id=q.user_id AND q.state='waiting';
-- Deliberately no key foreign key: removing a queued public key cancels that request at dispatch,
-- rather than silently falling back to another key or preventing the user from deleting it.
CREATE UNIQUE INDEX queue_entries_request_key_idx ON queue_entries(user_id,request_key) WHERE request_key IS NOT NULL;
