CREATE TABLE image_cleanup_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  registry_enabled boolean NOT NULL DEFAULT false,
  registry_keep integer NOT NULL DEFAULT 3 CHECK(registry_keep BETWEEN 1 AND 100),
  registry_days integer NOT NULL DEFAULT 30 CHECK(registry_days BETWEEN 1 AND 3650),
  cache_enabled boolean NOT NULL DEFAULT false,
  cache_days integer NOT NULL DEFAULT 30 CHECK(cache_days BETWEEN 1 AND 3650),
  cache_max_gb integer NOT NULL DEFAULT 0 CHECK(cache_max_gb BETWEEN 0 AND 100000),
  interval_hours integer NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 720),
  last_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO image_cleanup_policy(id) VALUES(true);
CREATE TABLE image_cleanup_jobs (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK(scope IN ('registry','cache')),
  host_id text,
  actor_id uuid REFERENCES users(id),
  automatic boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
  stage text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX image_cleanup_registry_active ON image_cleanup_jobs(scope) WHERE scope='registry' AND state IN ('queued','running');
CREATE UNIQUE INDEX image_cleanup_cache_active ON image_cleanup_jobs(host_id) WHERE scope='cache' AND state IN ('queued','running');
CREATE TABLE image_removals (
  repository text NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^sha256:[a-f0-9]{64}$'),
  refs text[] NOT NULL DEFAULT '{}',
  job_id uuid REFERENCES image_cleanup_jobs(id),
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(repository,digest)
);
-- Reject stale launch/profile updates, including requests admitted before deletion.
CREATE FUNCTION rdf_assert_image_available() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE image_ref text;
BEGIN
  IF TG_TABLE_NAME='profiles' THEN
    IF NOT NEW.enabled OR NEW.removed_at IS NOT NULL THEN RETURN NEW; END IF;
    image_ref := NEW.image;
  ELSIF TG_TABLE_NAME='sessions' THEN
    IF TG_OP='UPDATE' AND NEW.launch_image IS NOT DISTINCT FROM OLD.launch_image AND OLD.state IN ('starting','running') THEN RETURN NEW; END IF;
    IF NEW.state NOT IN ('starting','running') THEN RETURN NEW; END IF;
    image_ref := NEW.launch_image;
  ELSIF TG_TABLE_NAME='queue_entries' THEN
    IF NEW.state <> 'waiting' THEN RETURN NEW; END IF;
    SELECT image INTO image_ref FROM profiles WHERE id=NEW.profile_id;
  ELSE
    IF NEW.state NOT IN ('queued','pulling') THEN RETURN NEW; END IF;
    image_ref := NEW.image;
  END IF;
  IF EXISTS(SELECT 1 FROM image_cleanup_jobs WHERE scope='registry' AND state IN ('queued','running'))
     AND current_setting('rdf.image_maintenance',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'image_maintenance' USING ERRCODE='55006';
  END IF;
  IF EXISTS(SELECT 1 FROM image_removals WHERE
    image_ref=ANY(refs) OR (image_ref ~ '(^|/)rdf-emulator[:@]' AND split_part(image_ref,'@',2)=digest)) THEN
    RAISE EXCEPTION 'image_removed' USING ERRCODE='55006';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profiles_image_available BEFORE INSERT OR UPDATE OF image,enabled ON profiles FOR EACH ROW EXECUTE FUNCTION rdf_assert_image_available();
CREATE TRIGGER sessions_image_available BEFORE INSERT OR UPDATE OF launch_image,state ON sessions FOR EACH ROW EXECUTE FUNCTION rdf_assert_image_available();
CREATE TRIGGER queue_image_available BEFORE INSERT OR UPDATE OF state,profile_id ON queue_entries FOR EACH ROW EXECUTE FUNCTION rdf_assert_image_available();
CREATE TRIGGER prewarm_image_available BEFORE INSERT OR UPDATE OF state,image ON image_prewarm_jobs FOR EACH ROW EXECUTE FUNCTION rdf_assert_image_available();
