-- Data partition and SD card sizes. `disk_gb` stays the default data partition size; `disk_max_gb` is how far a user may
-- raise it when starting a session (NULL = fixed). `sdcard_gb` is the default SD card (NULL = no card) and
-- `sdcard_max_gb` the most a user may choose (NULL = fixed at the default). Sessions and queue entries keep the choice.
ALTER TABLE profiles ADD COLUMN disk_max_gb integer CHECK (disk_max_gb IS NULL OR disk_max_gb BETWEEN 2 AND 128);
ALTER TABLE profiles ADD COLUMN sdcard_gb integer CHECK (sdcard_gb IS NULL OR sdcard_gb BETWEEN 1 AND 32);
ALTER TABLE profiles ADD COLUMN sdcard_max_gb integer CHECK (sdcard_max_gb IS NULL OR sdcard_max_gb BETWEEN 1 AND 32);
ALTER TABLE sessions ADD COLUMN launch_disk_gb integer;
ALTER TABLE sessions ADD COLUMN launch_sdcard_gb integer;
ALTER TABLE queue_entries ADD COLUMN disk_gb integer;
ALTER TABLE queue_entries ADD COLUMN sdcard_gb integer;
