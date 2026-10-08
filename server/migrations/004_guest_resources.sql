ALTER TABLE profiles
  ADD COLUMN guest_memory_mb integer CHECK (guest_memory_mb BETWEEN 1024 AND 64512),
  ADD COLUMN guest_cores integer CHECK (guest_cores BETWEEN 1 AND 16),
  ADD CONSTRAINT guest_memory_fits_container CHECK (guest_memory_mb IS NULL OR guest_memory_mb <= memory_mb - 1024),
  ADD CONSTRAINT guest_cores_fit_container CHECK (guest_cores IS NULL OR guest_cores <= cpu);
