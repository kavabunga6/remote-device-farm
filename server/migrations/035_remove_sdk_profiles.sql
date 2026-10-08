-- Profiles whose image is built from the Android SDK (rdf-sdk-emulator:*) cannot run any more: emulators start
-- from Docker images only. Remove every leftover one; a profile that sessions or queue entries still reference
-- cannot be deleted, so it is disabled instead. Profiles with a regular Docker image are not touched.
UPDATE profiles SET enabled=false
 WHERE image LIKE 'rdf-sdk-emulator:%'
   AND (EXISTS (SELECT 1 FROM sessions s WHERE s.profile_id=profiles.id)
     OR EXISTS (SELECT 1 FROM queue_entries q WHERE q.profile_id=profiles.id));
DELETE FROM profiles
 WHERE image LIKE 'rdf-sdk-emulator:%'
   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.profile_id=profiles.id)
   AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.profile_id=profiles.id);
