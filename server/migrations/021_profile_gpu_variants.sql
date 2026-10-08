ALTER TABLE profiles ADD COLUMN gpu_image text;
ALTER TABLE profiles ADD COLUMN image_flavor text CHECK (image_flavor IN ('aosp','google_apis','google_play'));
ALTER TABLE sessions ADD COLUMN gpu_mode text CHECK (gpu_mode IN ('software','nvidia'));
ALTER TABLE sessions ADD COLUMN launch_image text;
ALTER TABLE queue_entries ADD COLUMN gpu_mode text CHECK (gpu_mode IN ('software','nvidia'));
ALTER TABLE profiles ADD COLUMN image_status text NOT NULL DEFAULT 'ready' CHECK (image_status IN ('ready','build_required'));
ALTER TABLE profiles ADD COLUMN device_type text CHECK (device_type IN ('mobile','tv','wear','automotive','desktop'));
ALTER TABLE profiles ADD COLUMN image_tag text;
