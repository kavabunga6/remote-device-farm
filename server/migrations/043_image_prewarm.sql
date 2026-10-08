CREATE TABLE image_prewarm_jobs (
  host_id text NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  image text NOT NULL CHECK (image ~ '@sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','pulling','done','failed')),
  error text,
  worker_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(host_id,image)
);
CREATE INDEX image_prewarm_pending ON image_prewarm_jobs(created_at) WHERE state IN ('queued','pulling');
