-- GPU is a launch option of a single image. Old columns remain for recovery only.
ALTER TABLE profiles ADD COLUMN gpu_support text NOT NULL DEFAULT 'none'
  CHECK (gpu_support IN ('none', 'cuda', 'gpu'));

-- Custom graphics commands need review rather than silently changing behavior.
UPDATE profiles SET enabled=false
WHERE docker_options ? 'gpu' AND (
  (docker_options->'gpu'->'flags' IS NOT NULL AND docker_options->'gpu'->'flags' NOT IN (
    '{}'::jsonb,
    '{"software":["-gpu","swiftshader_indirect"],"accelerated":["-gpu","host"]}'::jsonb,
    '{"accelerated":["-gpu","host"]}'::jsonb,
    '{"software":["-gpu","swiftshader_indirect"]}'::jsonb
  )) OR
  (docker_options->'gpu'->'env' IS NOT NULL AND NOT (
    '{"software":{"GPU_ACCELERATED":"false"},"accelerated":{"GPU_ACCELERATED":"true"}}'::jsonb
      @> (docker_options->'gpu'->'env')
  )) OR
  (docker_options->'gpu'->'capabilities' IS NOT NULL AND NOT (
    jsonb_typeof(docker_options->'gpu'->'capabilities') = 'array' AND
    (docker_options->'gpu'->'capabilities') @> '["compute","graphics","utility","display"]'::jsonb AND
    (docker_options->'gpu'->'capabilities') <@ '["compute","graphics","utility","display"]'::jsonb
  ))
);

UPDATE profiles SET
  gpu_support = CASE
    WHEN nullif(trim(gpu_image), '') IS NOT NULL OR gpu_mode='nvidia'
      THEN CASE WHEN docker_options->'gpu'->>'kind'='dri' THEN 'gpu' ELSE 'cuda' END
    ELSE 'none'
  END,
  image = coalesce(nullif(trim(gpu_image), ''), image),
  memory_mb = CASE
    WHEN nullif(trim(gpu_image), '') IS NOT NULL OR gpu_mode='nvidia'
      THEN greatest(memory_mb, coalesce(gpu_memory_mb, memory_mb))
    ELSE memory_mb
  END,
  docker_options = docker_options - 'gpu',
  container_env = container_env - ARRAY(
    SELECT name FROM jsonb_object_keys(container_env) AS names(name)
    WHERE upper(name) = 'GPU_ACCELERATED'
  );
