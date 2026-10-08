-- Emulators run from Docker images only. The profiles that existed to build images from the Android SDK on first
-- launch (image rdf-sdk-emulator:*) are removed; the readiness flag that only they used goes with them.
-- A profile that past sessions or queue entries still reference cannot be deleted; it is disabled instead.
UPDATE profiles SET enabled=false
 WHERE image LIKE 'rdf-sdk-emulator:%'
   AND (EXISTS (SELECT 1 FROM sessions s WHERE s.profile_id=profiles.id)
     OR EXISTS (SELECT 1 FROM queue_entries q WHERE q.profile_id=profiles.id));
DELETE FROM profiles
 WHERE image LIKE 'rdf-sdk-emulator:%'
   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.profile_id=profiles.id)
   AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.profile_id=profiles.id);
ALTER TABLE profiles DROP COLUMN image_status;
