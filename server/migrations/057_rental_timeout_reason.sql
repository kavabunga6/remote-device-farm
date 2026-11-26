ALTER TABLE rental_history ADD COLUMN timeout_reason text
  CHECK (timeout_reason IN ('idle', 'max_lifetime', 'lease_expired'));

-- Recover the outcome of sessions released by earlier brokers.
UPDATE rental_history h
SET timeout_reason = expired.reason
FROM (
  SELECT DISTINCT ON (target_id) target_id,
    CASE action
      WHEN 'session.released_idle' THEN 'idle'
      WHEN 'session.released_expired' THEN 'max_lifetime'
      WHEN 'session.released_lease' THEN 'lease_expired'
    END AS reason
  FROM audit_events
  WHERE target_type = 'session'
    AND action IN ('session.released_idle', 'session.released_expired', 'session.released_lease')
  ORDER BY target_id, id DESC
) expired
WHERE h.session_id::text = expired.target_id AND h.ended_at IS NOT NULL;
