-- Waiting list for slots, per-user notifications and webhooks.
CREATE TABLE queue_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES profiles(id),
  host_id text REFERENCES hosts(id),
  label text,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','assigned','cancelled','expired')),
  session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  claimed_at timestamptz
);
CREATE INDEX queue_entries_waiting_idx ON queue_entries(created_at) WHERE state = 'waiting';
CREATE INDEX queue_entries_user_idx ON queue_entries(user_id, state);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('session.ready','session.expiring','session.released','queue.assigned')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_session_idx ON notifications(session_id, kind, created_at);
CREATE UNIQUE INDEX notifications_queue_assigned_once_idx ON notifications(session_id) WHERE kind='queue.assigned' AND session_id IS NOT NULL;

CREATE TABLE webhooks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_status text,
  last_attempt_at timestamptz
);
CREATE INDEX webhooks_user_idx ON webhooks(user_id);
