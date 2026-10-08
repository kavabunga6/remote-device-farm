-- Raise the untouched test-host profile above the Google image's 4 GiB guest RAM.
-- Profiles already customized by an administrator keep their chosen resources.
UPDATE profiles
SET cpu = 4, memory_mb = 6144
WHERE id = 'android-30' AND cpu = 2 AND memory_mb = 3072;
