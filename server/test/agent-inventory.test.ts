import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { listAgentInventory } from '../src/agent-inventory.js';

test('agent inventory includes bootstrap, protects config-token collisions, and hides removed hosts and credentials', async () => {
  const db = new PGlite();
  try {
    for (const version of ['001_init', '005_host_settings', '011_node_management']) {
      await db.exec(await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8'));
    }
    const pool = { query: db.query.bind(db) } as unknown as Pool;
    await db.query(`INSERT INTO hosts(id,name,display_name,status,last_seen_at) VALUES
      ('bootstrap','Linux machine','QA node','online',now()),
      ('removed','Old',NULL,'offline',NULL)`);
    await db.query(`UPDATE hosts SET removed_at=now() WHERE id='removed'`);
    await db.query(`INSERT INTO agent_credentials(host_id,token_hash) VALUES ('waiting','secret-hash'),('removed','removed-hash')`);
    let inventory = await listAgentInventory(pool, 'bootstrap');
    assert.equal(inventory.length, 2);
    assert.deepEqual(inventory.find(item => item.hostId === 'bootstrap'), {
      hostId: 'bootstrap', name: 'QA node', status: 'online', source: 'environment', canRevoke: false,
      createdAt: inventory.find(item => item.hostId === 'bootstrap')!.createdAt,
      lastSeenAt: inventory.find(item => item.hostId === 'bootstrap')!.lastSeenAt,
    });
    assert.ok(inventory.find(item => item.hostId === 'bootstrap')!.lastSeenAt);
    assert.equal(inventory.find(item => item.hostId === 'waiting')!.canRevoke, true);
    assert.equal(inventory.find(item => item.hostId === 'waiting')!.source, 'registered');
    assert.equal(JSON.stringify(inventory).includes('hash'), false);

    await db.query(`INSERT INTO agent_credentials(host_id,token_hash) VALUES ('bootstrap','collision-hash')`);
    inventory = await listAgentInventory(pool, 'bootstrap');
    assert.equal(inventory.filter(item => item.hostId === 'bootstrap').length, 1);
    assert.equal(inventory.find(item => item.hostId === 'bootstrap')!.canRevoke, false);
    assert.equal(inventory.find(item => item.hostId === 'bootstrap')!.source, 'environment');
    assert.equal((await listAgentInventory(pool, 'never-connected')).some(item => item.hostId === 'never-connected'), false);
    assert.equal((await listAgentInventory(pool, 'removed')).some(item => item.hostId === 'removed'), false);
  } finally { await db.close(); }
});
