-- A durable receipt prevents old agent snapshots from re-importing an earlier digest.
-- Receipts and generated profiles are committed together before the agent may evict its result.
CREATE TABLE emulator_image_job_receipts (
  host_id text NOT NULL,
  job_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('done', 'failed')),
  repository text NOT NULL,
  package text NOT NULL,
  digest text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, job_id)
);
