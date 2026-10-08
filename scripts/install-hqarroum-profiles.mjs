#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Deliberately opt-in: application startup and schema migrations never import this catalogue.
// The dated tags must already be built and smoke-tested on every eligible node before --apply.
export const PROFILES = Object.freeze([
  { api: 31, android: '12' },
  { api: 32, android: '12L' },
  { api: 33, android: '13' },
].map(({ api, android }) => Object.freeze({
  id: `hqarroum-api${api}-google-apis-x64`,
  name: `Android ${android} · Google APIs · HQarroum`,
  androidVersion: `${android} (API ${api})`,
  image: `rdf-hqarroum-emulator:api-${api}`,
  cpu: 4, memoryMb: 4096, guestMemoryMb: 2048, guestCores: 2,
  diskGb: 16, diskMaxGb: 16, sdcardGb: null, sdcardMaxGb: null,
  emulatorParams: '-no-snapshot', containerEnv: Object.freeze({}),
  recommended: false, apiLevel: api, abi: 'x86_64',
  imageFlavor: 'google_apis', deviceType: 'mobile', imageTag: 'google_apis',
  deviceModel: null, resolution: null,
})));

class InstallerError extends Error {}

const insertion = `INSERT INTO profiles (
  id,name,android_version,image,cpu,memory_mb,guest_memory_mb,guest_cores,
  disk_gb,disk_max_gb,sdcard_gb,sdcard_max_gb,emulator_params,container_env,
  recommended,api_level,abi,image_flavor,
  device_type,image_tag,device_model,resolution,enabled,removed_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
  $15,$16,$17,$18,$19,$20,$21,$22,true,NULL)
ON CONFLICT (id) DO NOTHING
RETURNING id,image,enabled,removed_at`;

function values(profile) {
  return [profile.id, profile.name, profile.androidVersion, profile.image,
    profile.cpu, profile.memoryMb, profile.guestMemoryMb, profile.guestCores,
    profile.diskGb, profile.diskMaxGb, profile.sdcardGb, profile.sdcardMaxGb,
    profile.emulatorParams, JSON.stringify(profile.containerEnv),
    profile.recommended, profile.apiLevel,
    profile.abi, profile.imageFlavor, profile.deviceType, profile.imageTag,
    profile.deviceModel, profile.resolution];
}

function existingAction(profile, row) {
  if (row.image !== profile.image) {
    throw new InstallerError(`Profile ID collision: ${profile.id} already has a different image. No profiles were changed.`);
  }
  return row.removed_at ? 'kept removed' : row.enabled ? 'kept enabled' : 'kept disabled';
}

/** Dependency injection keeps the transaction verifiable without accessing a real farm. */
export async function installProfiles(pool, { apply = false, validateProfile } = {}) {
  if (typeof validateProfile !== 'function') throw new InstallerError('A server profile validator is required.');
  // Validate the entire manifest before acquiring a connection or writing any rows.
  const profiles = PROFILES.map(profile => validateProfile(profile));
  const client = await pool.connect();
  let began = false;
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began = true;
    if (apply) await client.query('SELECT pg_advisory_xact_lock(734613205)');
    const result = await client.query(
      `SELECT id,image,enabled,removed_at FROM profiles WHERE id=ANY($1::text[])${apply ? ' FOR UPDATE' : ''}`,
      [profiles.map(profile => profile.id)]);
    const existing = new Map(result.rows.map(row => [row.id, row]));
    // Check every collision first, so an invalid catalogue cannot partly install.
    for (const profile of profiles) if (existing.has(profile.id)) existingAction(profile, existing.get(profile.id));
    const report = [];
    for (const profile of profiles) {
      let row = existing.get(profile.id);
      let action;
      if (row) action = existingAction(profile, row);
      else if (!apply) action = 'would create enabled';
      else {
        const inserted = await client.query(insertion, values(profile));
        row = inserted.rows[0];
        if (row) action = 'created enabled';
        else {
          // A concurrent API creator does not take our advisory lock. Re-check the
          // row after ON CONFLICT instead of silently accepting a different image.
          const concurrent = await client.query(
            'SELECT id,image,enabled,removed_at FROM profiles WHERE id=$1 FOR UPDATE', [profile.id]);
          row = concurrent.rows[0];
          if (!row) throw new InstallerError(`Profile changed concurrently: ${profile.id}. Retry the installer.`);
          action = existingAction(profile, row);
        }
      }
      report.push({ id: profile.id, name: profile.name, image: profile.image, action });
    }
    await client.query('COMMIT');
    began = false;
    return report;
  } catch (error) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function runtime() {
  const candidates = [process.cwd(), fileURLToPath(new URL('../server/', import.meta.url))];
  const root = candidates.find(candidate => existsSync(path.join(candidate, 'dist', 'http-common.js')));
  if (!root) throw new InstallerError('Run from the built server directory (/app), or build server/dist before running locally.');
  return { require: createRequire(path.join(root, 'package.json')), parser: pathToFileURL(path.join(root, 'dist', 'http-common.js')).href };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/install-hqarroum-profiles.mjs [--apply]');
    console.log('Default: read-only dry run. --apply adds only new, enabled software profiles after external image smoke tests.');
    console.log('Requires DATABASE_URL and the built server runtime; existing profiles are never updated or restored.');
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) {
    throw new InstallerError('Unknown arguments. Use --help or --apply; no argument means a dry run.');
  }
  if (!process.env.DATABASE_URL) throw new InstallerError('DATABASE_URL is required. Its value will not be printed.');
  const { require, parser } = runtime();
  const { Pool } = require('pg');
  const { parseProfile } = await import(parser);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const apply = args[0] === '--apply';
    const report = await installProfiles(pool, { apply, validateProfile: parseProfile });
    console.table(report);
    console.log(apply ? 'Installation complete. Existing profiles were preserved.' : 'Dry run only. After verifying all three images, use --apply to install the missing profiles.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Driver errors can contain connection details. Never print the environment,
    // connection string, credentials, or an unfiltered database exception.
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'runtime error';
    console.error(error instanceof InstallerError ? error.message : `Installation failed (${code}). Check the server runtime and database connection.`);
    process.exitCode = 1;
  });
}
