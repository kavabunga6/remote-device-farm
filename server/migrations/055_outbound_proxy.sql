CREATE TABLE outbound_proxy_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  url text NOT NULL DEFAULT '',
  username text NOT NULL DEFAULT '',
  password text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO outbound_proxy_settings(id) VALUES (true);
