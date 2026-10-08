-- Per-host slot usage samples for utilization charts (14-day retention is applied by the sampler).
CREATE TABLE IF NOT EXISTS ops_samples (
  host_id text NOT NULL,
  at timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  total integer NOT NULL CHECK (total >= 0),
  PRIMARY KEY (host_id, at)
);
CREATE INDEX IF NOT EXISTS ops_samples_at_idx ON ops_samples(at);
