-- Only release-channel images are offered. Profiles imported from the retired SDK catalog for the beta, dev and
-- canary channels and for preview/codename builds (CANARY, DEV, CinnamonBun, "канал 2") are removed.
-- A profile that sessions or queue entries still reference cannot be deleted; it is disabled instead.
-- Profiles an administrator wrote by hand are never touched: only the exact SDK image names below match.
CREATE TEMP TABLE non_release_images(image text PRIMARY KEY);
INSERT INTO non_release_images(image) VALUES
  ('rdf-sdk-emulator:google-sdk-android-28-android-automotive-playstore-x86'),
  ('rdf-sdk-emulator:google-sdk-android-29-android-automotive-playstore-x86'),
  ('rdf-sdk-emulator:google-sdk-android-30-android-automotive-playstore-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-automotive-distant-display-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-automotive-distant-display-playstore-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-automotive-distant-display-playstore-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-automotive-distant-display-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-automotive-playstore-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-automotive-playstore-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-desktop-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-32-android-desktop-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-34-google-xr-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-34-google-xr-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-35-android-wear-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-35-android-wear-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-37-0-android-desktop-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-37-0-android-desktop-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta1-google-apis-playstore-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta1-google-apis-playstore-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta1-google-apis-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta1-google-apis-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta2-google-apis-playstore-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta2-google-apis-playstore-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta2-google-apis-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta2-google-apis-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta3-google-apis-playstore-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta3-google-apis-playstore-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta3-google-apis-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-37-2-beta3-google-apis-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-canary-20260909-google-apis-playstore-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-canary-20260909-google-apis-playstore-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-canary-20260909-google-apis-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-canary-20260909-google-apis-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-canary-google-apis-playstore-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-canary-google-apis-playstore-ps16k-x86-64'),
  ('rdf-sdk-emulator:google-sdk-android-canary-google-apis-ps16k-arm64-v8a'),
  ('rdf-sdk-emulator:google-sdk-android-canary-google-apis-ps16k-x86-64');
UPDATE profiles SET enabled=false
 WHERE image IN (SELECT image FROM non_release_images)
   AND (EXISTS (SELECT 1 FROM sessions s WHERE s.profile_id=profiles.id)
     OR EXISTS (SELECT 1 FROM queue_entries q WHERE q.profile_id=profiles.id));
DELETE FROM profiles
 WHERE image IN (SELECT image FROM non_release_images)
   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.profile_id=profiles.id)
   AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.profile_id=profiles.id);
DROP TABLE non_release_images;
