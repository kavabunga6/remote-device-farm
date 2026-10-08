-- Pin only the stock starter tag; custom images and historical session snapshots stay intact.
UPDATE profiles SET image='us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2@sha256:e78ac1816acef59e40285e90003acd490ef54bb3242ed088afa31bc982577050'
WHERE image='us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:30.1.2';
