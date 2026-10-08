-- Physical devices and emulators that fail their post-session wipe are quarantined and admins are notified.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('session.ready','session.expiring','session.released','queue.assigned','device.quarantined'));
-- Last device inventory reported by the agent (state: free / busy / cleaning / quarantined).
ALTER TABLE hosts ADD COLUMN devices jsonb NOT NULL DEFAULT '[]';
