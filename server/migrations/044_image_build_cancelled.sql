-- Cancelled builds are terminal receipts, but must never create image/profile rows.
ALTER TABLE emulator_image_job_receipts
  DROP CONSTRAINT emulator_image_job_receipts_state_check,
  ADD CONSTRAINT emulator_image_job_receipts_state_check CHECK (state IN ('done', 'failed', 'cancelled'));
