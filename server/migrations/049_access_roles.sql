CREATE TABLE access_roles (
 id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 builtin text UNIQUE CHECK (builtin IN ('admin','user')),
 permissions text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_roles_name_idx ON access_roles(lower(name));
INSERT INTO access_roles(id,name,builtin,permissions) VALUES
 ('00000000-0000-4000-8000-000000000001','Administrator','admin','{}'),
 ('00000000-0000-4000-8000-000000000002','User','user',ARRAY['sessions.view','sessions.create','sessions.stop','sessions.control','sessions.console','sessions.files','sessions.adb','sessions.env','sessions.share','sessions.logcat','sessions.launchOptions','tokens.personal']);
ALTER TABLE users ADD COLUMN access_role_id uuid REFERENCES access_roles(id) ON DELETE RESTRICT;
UPDATE users SET access_role_id=(SELECT id FROM access_roles WHERE builtin=users.role);
ALTER TABLE users ALTER COLUMN access_role_id SET NOT NULL;
CREATE INDEX users_access_role_idx ON users(access_role_id);
CREATE FUNCTION sync_user_access_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.access_role_id IS NULL OR (TG_OP='UPDATE' AND NEW.role IS DISTINCT FROM OLD.role AND NEW.access_role_id=OLD.access_role_id) THEN
  SELECT id INTO NEW.access_role_id FROM access_roles WHERE builtin=NEW.role;
 END IF;
 SELECT CASE WHEN builtin='admin' THEN 'admin' ELSE 'user' END INTO NEW.role FROM access_roles WHERE id=NEW.access_role_id;
 RETURN NEW;
END
$$;
CREATE TRIGGER users_access_role BEFORE INSERT OR UPDATE OF role,access_role_id ON users FOR EACH ROW EXECUTE FUNCTION sync_user_access_role();
