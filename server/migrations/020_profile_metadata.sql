-- Descriptive image metadata is optional. Never infer an ABI from an image name.
ALTER TABLE profiles
  ADD COLUMN api_level integer CHECK (api_level BETWEEN 1 AND 999),
  ADD COLUMN abi varchar(120),
  ADD COLUMN device_model varchar(120),
  ADD COLUMN resolution varchar(20);
