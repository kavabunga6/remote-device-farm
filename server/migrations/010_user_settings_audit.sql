ALTER TABLE users
  ADD COLUMN first_name text,
  ADD COLUMN last_name text,
  ADD COLUMN job_title text;

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  font_family text NOT NULL DEFAULT 'system' CHECK (font_family IN ('system','inter','mono')),
  font_scale numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (font_scale BETWEEN 0.80 AND 1.40),
  default_adb_key_id uuid REFERENCES user_adb_public_keys(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- This is a minimal usage ledger, independent of the disposable session row.
-- It contains no emulator files, command text, display frames or credentials.
CREATE TABLE rental_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_username text NOT NULL,
  host_id text NOT NULL,
  host_name text NOT NULL,
  profile_id text NOT NULL,
  profile_name text NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  final_state text CHECK (final_state IN ('starting','running','stopping','stopped','failed'))
);
CREATE INDEX rental_history_owner_id_idx ON rental_history(owner_user_id,id DESC);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_username text,
  subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  outcome text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failed','denied')),
  target_type text,
  target_id text
);
CREATE INDEX audit_events_occurred_idx ON audit_events(id DESC);
CREATE INDEX audit_events_subject_idx ON audit_events(subject_user_id,id DESC);

CREATE TABLE service_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  service text NOT NULL CHECK (service IN ('server','agent','emulator')),
  severity text NOT NULL CHECK (severity IN ('info','warning','error')),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  host_id text,
  session_id uuid
);
CREATE INDEX service_logs_occurred_idx ON service_logs(id DESC);

CREATE FUNCTION record_host_availability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO service_logs(service,severity,code,host_id)
    VALUES('agent',CASE WHEN NEW.status='online' THEN 'info' ELSE 'warning' END,
           CASE WHEN NEW.status='online' THEN 'agent.online' ELSE 'agent.offline' END,NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER host_availability_log
AFTER INSERT OR UPDATE OF status ON hosts
FOR EACH ROW EXECUTE FUNCTION record_host_availability();

CREATE FUNCTION record_session_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO rental_history(session_id,owner_user_id,owner_username,host_id,host_name,
                               profile_id,profile_name,created_at,started_at)
    SELECT NEW.id,NEW.owner_user_id,u.username,NEW.host_id,COALESCE(h.display_name,h.name),
           NEW.profile_id,p.name,NEW.created_at,NEW.started_at
      FROM users u,hosts h,profiles p
     WHERE u.id=NEW.owner_user_id AND h.id=NEW.host_id AND p.id=NEW.profile_id;
    INSERT INTO audit_events(actor_user_id,actor_username,subject_user_id,action,target_type,target_id)
    SELECT NEW.owner_user_id,u.username,NEW.owner_user_id,'session.created','session',NEW.id::text
      FROM users u WHERE u.id=NEW.owner_user_id;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      UPDATE rental_history SET started_at=NEW.started_at WHERE session_id=NEW.id;
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state THEN
      INSERT INTO audit_events(subject_user_id,action,target_type,target_id)
      VALUES(NEW.owner_user_id,'session.' || NEW.state,'session',NEW.id::text);
      IF NEW.state='failed' THEN
        INSERT INTO service_logs(service,severity,code,host_id,session_id)
        VALUES('emulator','error','emulator.failed',NEW.host_id,NEW.id);
      END IF;
    END IF;
    RETURN NEW;
  ELSE
    UPDATE rental_history SET ended_at=now(),final_state=OLD.state WHERE session_id=OLD.id;
    INSERT INTO audit_events(subject_user_id,action,target_type,target_id)
    VALUES(OLD.owner_user_id,'session.released','session',OLD.id::text);
    INSERT INTO service_logs(service,severity,code,host_id,session_id)
    VALUES('emulator',
      CASE WHEN OLD.state IN ('starting','failed') THEN 'warning' ELSE 'info' END,
      CASE WHEN OLD.state IN ('starting','failed') THEN 'emulator.start_ended' ELSE 'emulator.released' END,
      OLD.host_id,OLD.id);
    RETURN OLD;
  END IF;
END;
$$;

CREATE TRIGGER sessions_lifecycle_audit
AFTER INSERT OR UPDATE OR DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION record_session_lifecycle();

-- Existing live sessions are included when this migration runs.
INSERT INTO rental_history(session_id,owner_user_id,owner_username,host_id,host_name,
                           profile_id,profile_name,created_at,started_at)
SELECT s.id,s.owner_user_id,u.username,s.host_id,COALESCE(h.display_name,h.name),
       s.profile_id,p.name,s.created_at,s.started_at
  FROM sessions s JOIN users u ON u.id=s.owner_user_id
  JOIN hosts h ON h.id=s.host_id JOIN profiles p ON p.id=s.profile_id
ON CONFLICT (session_id) DO NOTHING;
