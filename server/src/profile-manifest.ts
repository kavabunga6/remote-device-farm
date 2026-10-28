import { uiMessage } from './messages.js';
import { ApiError, parseProfile } from './http-common.js';

// A profile manifest describes images and how to start them as one JSON document. Unknown fields are errors, not
// silently ignored, and every value goes through the same rules as the profile form (parseProfile).
export const MANIFEST_VERSION = 2;
export const MAX_MANIFEST_PROFILES = 50;

type Obj = Record<string, unknown>;
export type ManifestIssue = { path: string; message: string };
export type ManifestProfile = { index: number; input: Obj; issues: ManifestIssue[]; warnings: string[] };

const isObj = (value: unknown): value is Obj => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function strict(value: unknown, allowed: string[], path: string, issues: ManifestIssue[]): Obj {
  if (!isObj(value)) { issues.push({ path, message: uiMessage('manifest.objectExpected', {}, 'en') }); return {}; }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push({ path: `${path}.${key}`, message: uiMessage('manifest.unknownField', {}, 'en') });
  return value;
}

/** Image reference from {repository, tag, digest} or a plain string. */
function imageReference(value: unknown, path: string, issues: ManifestIssue[], warnings: string[]): string {
  if (typeof value === 'string') { if (!/@sha256:[0-9a-f]{64}$/.test(value)) warnings.push(uiMessage('manifest.unpinnedImage', {}, 'en')); return value; }
  const image = strict(value, ['repository', 'tag', 'digest'], path, issues);
  if (typeof image.repository !== 'string' || !image.repository) { issues.push({ path: `${path}.repository`, message: uiMessage('manifest.repositoryRequired', {}, 'en') }); return ''; }
  const tag = typeof image.tag === 'string' && image.tag ? `:${image.tag}` : '';
  const digest = typeof image.digest === 'string' && image.digest ? `@${image.digest}` : '';
  if (image.digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(String(image.digest))) issues.push({ path: `${path}.digest`, message: uiMessage('manifest.digestInvalid', {}, 'en') });
  if (!digest) warnings.push(uiMessage('manifest.unpinnedImage', {}, 'en'));
  return `${image.repository}${tag}${digest}`;
}

/** Splits params given as a list (preferred) or one string into the profile's single string. */
function paramsString(value: unknown, path: string, issues: ManifestIssue[]): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(item => typeof item === 'string' && !/\s/.test(item))) return value.join(' ');
  issues.push({ path, message: uiMessage('manifest.paramsInvalid', {}, 'en') });
  return '';
}

export function parseManifest(body: unknown): { profiles: ManifestProfile[]; issues: ManifestIssue[] } {
  const top: ManifestIssue[] = [];
  if (!isObj(body)) throw new ApiError(400, 'invalid_manifest', uiMessage('ui.5b56ea78213a', {}, 'en'));
  strict(body, ['version', 'profiles'], '$', top);
  if (body.version !== 1 && body.version !== MANIFEST_VERSION) top.push({ path: '$.version', message: uiMessage('manifest.versionUnsupported', { p0: MANIFEST_VERSION }, 'en') });
  if (!Array.isArray(body.profiles) || !body.profiles.length) throw new ApiError(400, 'invalid_manifest', uiMessage('ui.dc6bfb53ffa2', {}, 'en'));
  if (body.profiles.length > MAX_MANIFEST_PROFILES) throw new ApiError(400, 'invalid_manifest', uiMessage('ui.d95a164adf05', { p0: MAX_MANIFEST_PROFILES }, 'en'));
  const profiles = (body.profiles as unknown[]).map((raw, index): ManifestProfile => {
    const path = `$.profiles[${index}]`;
    const issues: ManifestIssue[] = []; const warnings: string[] = [];
    const item = strict(raw, ['id', 'name', 'recommended', 'allowLaunchOverrides', 'image', 'android', 'resources', 'emulator', 'container', 'launch', 'gpu', ...(body.version === 1 ? ['gpuImage'] : [])], path, issues);
    const android = strict(item.android ?? {}, ['version', 'api', 'abi', 'deviceModel', 'resolution', 'flavor', 'deviceType'], `${path}.android`, issues);
    const resources = strict(item.resources ?? {}, ['cpu', 'memoryMb', 'guestMemoryMb', 'guestCores', 'diskGb', 'diskMaxGb', 'sdcardGb', 'sdcardMaxGb'], `${path}.resources`, issues);
    const emulator = strict(item.emulator ?? {}, ['params'], `${path}.emulator`, issues);
    const container = strict(item.container ?? {}, ['env', 'command', 'entrypoint', 'shmSizeMb', 'ulimits', 'tmpfs', 'sysctls'], `${path}.container`, issues);
    const launch = strict(item.launch ?? {}, ['emulatorParamsEnv', 'adbKeyEnv', 'farmFlags'], `${path}.launch`, issues);
    if (item.gpu !== undefined || item.gpuImage !== undefined) {
      warnings.push(uiMessage('manifest.legacyGpu', {}, 'en'));
    }
    const input: Obj = {
      id: item.id, name: item.name, recommended: item.recommended, allowLaunchOverrides: item.allowLaunchOverrides,
      image: imageReference(item.image, `${path}.image`, issues, warnings),
      androidVersion: android.version == null ? undefined : String(android.version), apiLevel: android.api, abi: android.abi,
      deviceModel: android.deviceModel, resolution: android.resolution, imageFlavor: android.flavor, deviceType: android.deviceType,
      ...resources,
      emulatorParams: paramsString(emulator.params, `${path}.emulator.params`, issues),
      containerEnv: container.env,
      dockerOptions: {
        ...(container.shmSizeMb === undefined ? {} : { shmSizeMb: container.shmSizeMb }),
        ...(container.ulimits === undefined ? {} : { ulimits: container.ulimits }),
        ...(container.tmpfs === undefined ? {} : { tmpfs: container.tmpfs }),
        ...(container.sysctls === undefined ? {} : { sysctls: container.sysctls }),
        ...(container.command === undefined ? {} : { command: container.command }),
        ...(container.entrypoint === undefined ? {} : { entrypoint: container.entrypoint }),
        ...(launch.emulatorParamsEnv === undefined ? {} : { emulatorParamsEnv: launch.emulatorParamsEnv }),
        ...(launch.adbKeyEnv === undefined ? {} : { adbKeyEnv: launch.adbKeyEnv }),
        ...(launch.farmFlags === undefined ? {} : { farmFlags: launch.farmFlags }),
      },
    };
    return { index, input, issues, warnings };
  });
  return { profiles, issues: top };
}

/** Runs the profile validation on a manifest item; returns the problem as an issue instead of throwing. */
export function checkManifestProfile(item: ManifestProfile, allowKeepEnv: boolean): { parsed?: ReturnType<typeof parseProfile>; issue?: ManifestIssue } {
  try { return { parsed: parseProfile(item.input, { allowKeepEnv }) }; }
  catch (error) {
    const message = error instanceof ApiError ? error.message : uiMessage('manifest.invalidProfile', {}, 'en');
    return { issue: { path: `$.profiles[${item.index}]`, message } };
  }
}

/** Profile rows as a manifest. Variable values are never exported: they come out as null, meaning "keep what is stored". */
export function exportManifest(rows: Array<Record<string, unknown>>) {
  return {
    version: MANIFEST_VERSION,
    profiles: rows.map(row => {
      const options = (row.docker_options && typeof row.docker_options === 'object' ? row.docker_options : {}) as Obj;
      const env = Object.fromEntries(Object.keys((row.container_env as Obj) || {}).map(name => [name, null]));
      return {
        id: row.id, name: row.name, recommended: row.recommended === true, allowLaunchOverrides: typeof row.allow_launch_overrides === 'boolean' ? row.allow_launch_overrides : null,
        image: String(row.image),
        android: { version: row.android_version, api: row.api_level, abi: row.abi, deviceModel: row.device_model, resolution: row.resolution, flavor: row.image_flavor, deviceType: row.device_type },
        resources: { cpu: row.cpu, memoryMb: row.memory_mb, guestMemoryMb: row.guest_memory_mb, guestCores: row.guest_cores, diskGb: row.disk_gb, diskMaxGb: row.disk_max_gb, sdcardGb: row.sdcard_gb, sdcardMaxGb: row.sdcard_max_gb },
        emulator: { params: String(row.emulator_params || '').split(/\s+/).filter(Boolean) },
        container: { env, ...Object.fromEntries(['shmSizeMb', 'ulimits', 'tmpfs', 'sysctls', 'command', 'entrypoint'].filter(key => options[key] !== undefined).map(key => [key, options[key]])) },
        launch: { ...(options.emulatorParamsEnv ? { emulatorParamsEnv: options.emulatorParamsEnv } : {}), ...(options.adbKeyEnv ? { adbKeyEnv: options.adbKeyEnv } : {}), ...(options.farmFlags ? { farmFlags: options.farmFlags } : {}) },
      };
    }),
  };
}
