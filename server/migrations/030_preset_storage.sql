-- Optional storage choice remembered by a personal preset; NULL means "use the profile defaults".
ALTER TABLE user_profile_presets ADD COLUMN disk_gb integer CHECK (disk_gb IS NULL OR disk_gb BETWEEN 2 AND 128);
ALTER TABLE user_profile_presets ADD COLUMN sdcard_gb integer CHECK (sdcard_gb IS NULL OR sdcard_gb BETWEEN 0 AND 32);
