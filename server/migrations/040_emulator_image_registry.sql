-- Farm emulator images: built once on the image builder node, pushed to a registry and pinned by digest.
ALTER TABLE hosts ADD COLUMN image_builder boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX hosts_single_image_builder ON hosts (image_builder) WHERE image_builder AND removed_at IS NULL;

-- One row per Google system image and registry: the digest every node pulls.
CREATE TABLE emulator_images (
  package text NOT NULL,                       -- system-images;android-34;google_apis_playstore;x86_64
  repository text NOT NULL,                    -- farm.example.com/rdf-emulator or registry.corp/rdf-emulator
  tag text NOT NULL,                           -- 34-google_apis_playstore-x86_64
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  size_mb integer,
  builder_host_id text,
  built_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository, package)
);

-- Short-lived credentials for the built-in registry: pull for session starts, push for the builder.
CREATE TABLE registry_tokens (
  token_hash text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('pull', 'push')),
  host_id text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX registry_tokens_expiry ON registry_tokens (expires_at);

-- Where farm images live: the built-in registry (served by the farm under /v2/) or a company registry.
CREATE TABLE registry_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode text NOT NULL DEFAULT 'builtin' CHECK (mode IN ('builtin', 'external')),
  builtin_address text,                        -- host[:port] nodes use to reach the farm registry
  external_address text,                       -- host[:port][/path] of the company registry
  external_username text,
  external_password text,                      -- sealed with SecretBox
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO registry_settings (id) VALUES (true);
