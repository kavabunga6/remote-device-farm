import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import type { Config } from './config.js';

export function createPool(config: Config): Pool {
  return new Pool({ connectionString: config.databaseUrl, max: 20, connectionTimeoutMillis: 5000 });
}

export async function migrate(pool: Pool): Promise<void> {
  const migrations = [
    { version: 1, file: '001_init.sql' },
    { version: 2, file: '002_gpu_mode.sql' },
    { version: 3, file: '003_default_profile_resources.sql' },
    { version: 4, file: '004_guest_resources.sql' },
    { version: 5, file: '005_host_settings.sql' },
    { version: 6, file: '006_adb_port_access.sql' },
    { version: 7, file: '007_purge_finished_sessions.sql' },
    { version: 8, file: '008_user_adb_keys.sql' },
    { version: 9, file: '009_uploaded_adb_public_keys.sql' },
    { version: 10, file: '010_user_settings_audit.sql' },
    { version: 11, file: '011_node_management.sql' },
    { version: 12, file: '012_session_lifecycle.sql' },
    { version: 13, file: '013_queue_notifications.sql' },
    { version: 14, file: '014_session_sharing.sql' },
    { version: 15, file: '015_app_store.sql' },
    { version: 16, file: '016_env_tools.sql' },
    { version: 17, file: '017_ops_metrics.sql' },
    { version: 18, file: '018_teams.sql' },
    { version: 19, file: '019_user_company.sql' },
    { version: 20, file: '020_profile_metadata.sql' },
    { version: 21, file: '021_profile_gpu_variants.sql' },
    { version: 22, file: '022_profile_gpu_memory.sql' },
    { version: 23, file: '023_user_profile_presets.sql' },
    { version: 24, file: '024_device_quarantine.sql' },
    { version: 25, file: '025_physical_devices.sql' },
    { version: 26, file: '026_session_startup_progress.sql' },
    { version: 27, file: '027_docker_images_only.sql' },
    { version: 28, file: '028_container_env.sql' },
    { version: 29, file: '029_storage_limits.sql' },
    { version: 30, file: '030_preset_storage.sql' },
    { version: 31, file: '031_client_leases.sql' },
    { version: 32, file: '032_queue_integration.sql' },
    { version: 33, file: '033_launch_options.sql' },
    { version: 34, file: '034_release_profiles_only.sql' },
    { version: 35, file: '035_remove_sdk_profiles.sql' },
    { version: 36, file: '036_profile_removal.sql' },
    { version: 37, file: '037_interface_scale.sql' },
    { version: 38, file: '038_profile_secrets_docker_options.sql' },
    { version: 39, file: '039_profile_gpu_support.sql' },
    { version: 40, file: '040_emulator_image_registry.sql' },
    { version: 41, file: '041_emulator_image_job_receipts.sql' },
    { version: 42, file: '042_pin_google_starter.sql' },
    { version: 43, file: '043_image_prewarm.sql' },
    { version: 44, file: '044_image_build_cancelled.sql' },
    { version: 45, file: '045_launch_permissions.sql' },
    { version: 46, file: '046_session_diagnostics.sql' },
    { version: 47, file: '047_image_runtime_checks.sql' },
    { version: 48, file: '048_user_removal.sql' },
    { version: 49, file: '049_access_roles.sql' },
    { version: 50, file: '050_image_management.sql' },
    { version: 51, file: '051_disable_unverified_starter.sql' },
    { version: 52, file: '052_session_device_metadata.sql' },
    { version: 53, file: '053_device_provider_status.sql' },
  ] as const;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(649736215)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    // A pre-merge development branch used 28..31 for different migrations.
    // Recognize that schema before reassigning only its bookkeeping entries.
    const legacy = await client.query<{ old_branch: boolean; has_lease: boolean; has_queue: boolean; lease_at: Date | null; queue_at: Date | null }>(`
      SELECT
        EXISTS(SELECT 1 FROM schema_migrations WHERE version=28)
          AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='profiles' AND column_name='container_env')
          AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='profiles' AND column_name='image_status') AS old_branch,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions' AND column_name='lease_ttl_seconds') AS has_lease,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='queue_entries' AND column_name='request_key') AS has_queue,
        (SELECT applied_at FROM schema_migrations WHERE version=29) AS lease_at,
        (SELECT applied_at FROM schema_migrations WHERE version=30) AS queue_at`);
    if (legacy.rows[0]?.old_branch) {
      const shape = await client.query<{ lease_columns: number; queue_columns: number; lease_constraint: boolean; lease_index: boolean; queue_index: boolean }>(`
        SELECT (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions' AND column_name IN ('lease_ttl_seconds','lease_expires_at')) AS lease_columns,
          (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='queue_entries' AND column_name IN ('adb_key_id','request_key','request_fingerprint','lease_ttl_seconds','error_code')) AS queue_columns,
          EXISTS(SELECT 1 FROM pg_constraint WHERE conname='session_lease_valid' AND conrelid='sessions'::regclass) AS lease_constraint,
          to_regclass('sessions_lease_expiry') IS NOT NULL AS lease_index,
          to_regclass('queue_entries_request_key_idx') IS NOT NULL AS queue_index`);
      const schema = shape.rows[0]!;
      if ((legacy.rows[0].has_lease && (schema.lease_columns !== 2 || !schema.lease_constraint || !schema.lease_index)) ||
          (!legacy.rows[0].has_lease && schema.lease_columns !== 0) ||
          (legacy.rows[0].has_queue && (schema.queue_columns !== 5 || !schema.queue_index)) ||
          (!legacy.rows[0].has_queue && schema.queue_columns !== 0)) throw new Error('Incomplete legacy development schema; migration bookkeeping was not changed');
      await client.query('DELETE FROM schema_migrations WHERE version BETWEEN 27 AND 31');
      if (legacy.rows[0].has_lease) await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES(31,COALESCE($1,now())) ON CONFLICT DO NOTHING', [legacy.rows[0].lease_at]);
      if (legacy.rows[0].has_queue) await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES(32,COALESCE($1,now())) ON CONFLICT DO NOTHING', [legacy.rows[0].queue_at]);
      // 33 is deliberately rerun: existing JSON columns are retained, then new
      // GiB columns are widened and old choices receive the compatibility view.
    }
    for (const migration of migrations) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [migration.version]);
      if (existing.rowCount) continue;
      const sql = await readFile(fileURLToPath(new URL(`../migrations/${migration.file}`, import.meta.url)), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [migration.version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
