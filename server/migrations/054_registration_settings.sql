CREATE TABLE registration_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 enabled boolean NOT NULL DEFAULT false,
 role_id uuid NOT NULL REFERENCES access_roles(id) ON DELETE RESTRICT
);
INSERT INTO registration_settings(id,enabled,role_id)
 VALUES(true,false,'00000000-0000-4000-8000-000000000002');
