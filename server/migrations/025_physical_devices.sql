-- Physical devices (USB Android) rent exactly like emulators but are identified by (host, device) instead of a slot.
ALTER TABLE hosts ADD COLUMN provider_capabilities jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN device_kind text NOT NULL DEFAULT 'emulator' CHECK (device_kind IN ('emulator','usb-android'));
ALTER TABLE sessions ADD COLUMN device_id text;
-- Snapshot of what the device can do (video, touch, shell, ...). NULL = everything (all emulator sessions).
ALTER TABLE sessions ADD COLUMN capabilities text[];
-- One active session per physical device, enforced by the database.
CREATE UNIQUE INDEX sessions_active_device_idx ON sessions(host_id, device_id)
  WHERE device_id IS NOT NULL AND state IN ('starting','running','stopping');
-- Sessions need a profile row; physical-device sessions use the disabled placeholder profiles `device-<kind>`,
-- created on first use by the server (not here, so emulator catalog counts stay untouched).
