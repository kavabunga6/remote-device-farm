ALTER TABLE sessions ADD COLUMN startup_progress jsonb;
ALTER TABLE sessions ADD COLUMN startup_deadline_at timestamptz;
ALTER TABLE sessions ADD CONSTRAINT sessions_startup_progress_object CHECK (startup_progress IS NULL OR jsonb_typeof(startup_progress)='object');

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('session.ready','session.expiring','session.released','session.failed','queue.assigned','device.quarantined'));
