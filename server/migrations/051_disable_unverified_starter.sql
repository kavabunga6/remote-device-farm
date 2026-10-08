-- Keep bundled legacy images unavailable until their runtime validation passes.
-- Preserve profiles using custom images and all session history.
UPDATE profiles SET enabled=false, recommended=false
WHERE image IN (
  'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2',
  'us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2@sha256:e78ac1816acef59e40285e90003acd490ef54bb3242ed088afa31bc982577050'
);
