-- A freed slot has no retained emulator state. Clear historical finished records.
UPDATE host_slots SET session_id=NULL
WHERE session_id IN (SELECT id FROM sessions WHERE state IN ('stopped','failed'));

-- ADB credentials linked to each session are removed by ON DELETE CASCADE.
DELETE FROM sessions WHERE state IN ('stopped','failed');
