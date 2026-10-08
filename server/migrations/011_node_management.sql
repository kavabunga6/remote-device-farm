-- Node policy is server-owned and survives agent reconnects. Historical sessions keep
-- their host reference after an administrator removes a node from the farm.
ALTER TABLE hosts
  ADD COLUMN slot_mode text NOT NULL DEFAULT 'manual' CHECK (slot_mode IN ('manual','dynamic')),
  ADD COLUMN manual_slots integer NOT NULL DEFAULT 1 CHECK (manual_slots BETWEEN 0 AND 32),
  ADD COLUMN slot_cpu integer NOT NULL DEFAULT 4 CHECK (slot_cpu BETWEEN 1 AND 16),
  ADD COLUMN slot_memory_mb integer NOT NULL DEFAULT 4096 CHECK (slot_memory_mb BETWEEN 1024 AND 65536),
  ADD COLUMN disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN policy_revision integer NOT NULL DEFAULT 0 CHECK (policy_revision BETWEEN 0 AND 1000000000),
  ADD COLUMN agent_policy_version integer NOT NULL DEFAULT 0 CHECK (agent_policy_version BETWEEN 0 AND 1),
  ADD COLUMN applied_policy_revision integer NOT NULL DEFAULT -1 CHECK (applied_policy_revision BETWEEN -1 AND 1000000000);

-- Preserve existing reported capacity or an explicit cap; newly enrolled nodes
-- start with the deliberate one-slot manual default.
UPDATE hosts SET manual_slots = LEAST(32, COALESCE(slot_cap, CASE WHEN slots > 0 THEN slots ELSE 1 END));
