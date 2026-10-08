ALTER TABLE hosts
  ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) <= 120),
  ADD COLUMN slot_cap integer CHECK (slot_cap BETWEEN 0 AND 256);
