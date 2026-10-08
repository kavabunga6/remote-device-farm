ALTER TABLE profiles ADD COLUMN gpu_memory_mb integer CHECK (gpu_memory_mb BETWEEN 1024 AND 65536);
ALTER TABLE sessions ADD COLUMN launch_memory_mb integer CHECK (launch_memory_mb BETWEEN 1024 AND 65536);
