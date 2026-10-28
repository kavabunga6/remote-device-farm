#!/usr/bin/env node
import { agentMessage } from './messages.mjs';
// Catalog of Google emulator system images for the farm image (agent/emulator-image). The agent uses it for the
// image catalog in the UI; deploy/emulator/build.sh uses the same CLI for manual and CI builds.
//
//   node emulator-catalog.mjs parse  < sdkmanager-list.txt            > catalog.json   # every stable system image Google publishes
//   node emulator-catalog.mjs select --abi x86_64 [--filter REGEX]    < catalog.json  # one line per image to build: "<package>\t<tag>"
//   node emulator-catalog.mjs manifest --registry rdf-emulator --abi x86_64 < catalog.json > profiles.json   # farm profile manifest
//
// No network access here: build.sh runs `sdkmanager --list` inside the tools stage and pipes the output in.

const ANDROID_VERSIONS = { 21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11',
  31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16', 37: '17' };
const MIN_API = 21;

/** Form factor of a system image, from its tag. Phone images are also offered as tablets by the manifest. */
export function deviceOf(tag) {
  if (/tv/.test(tag)) return 'tv';
  if (/automotive/.test(tag)) return 'automotive';
  if (/wear/.test(tag)) return 'wear';
  if (/desktop/.test(tag)) return 'desktop';
  if (/xr/.test(tag)) return null; // XR images need a headset profile the farm does not stream.
  return 'phone';
}

/** Farm image flavor: Play Store, Google APIs or plain AOSP. */
export function flavorOf(tag) {
  // Wear OS images are Google's Wear OS with Play; android-tv and android-automotive are AOSP builds.
  if (/playstore|google-tv|^android-wear$/.test(tag)) return 'google_play';
  if (/google/.test(tag)) return 'google_apis';
  return 'aosp';
}

/** Parses one `system-images;android-34-ext10;google_apis;x86_64` package path; null for previews and unknown shapes. */
export function parsePackage(path) {
  const match = /^system-images;android-(\d+)(?:\.(\d+))?(?:-ext(\d+))?;([a-z0-9_.-]+);(x86_64|x86|arm64-v8a|armeabi-v7a)$/.exec(path);
  if (!match) return null;
  const api = Number(match[1]);
  if (api < MIN_API) return null;
  const tag = match[4];
  const device = deviceOf(tag);
  if (!device) return null;
  return { package: path, api, minor: match[2] ? Number(match[2]) : null, extension: match[3] ? Number(match[3]) : null,
    tag, abi: match[5], device, flavor: flavorOf(tag), pageSize16k: /ps16k|16k/.test(tag),
    androidVersion: ANDROID_VERSIONS[api] ?? String(api) };
}

/** Reads `sdkmanager --list` output; keeps the "Available Packages" section, one entry per package (latest revision). */
export function parseSdkList(text) {
  const entries = new Map();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Available Packages:/i.test(line)) { section = 'available'; continue; }
    if (/^(Installed packages|Available Updates):/i.test(line)) { section = 'other'; continue; }
    if (section !== 'available' || !line.startsWith('system-images;')) continue;
    const [path, revision = '', description = ''] = line.split('|').map(part => part.trim());
    const parsed = parsePackage(path);
    if (parsed) entries.set(path, { ...parsed, revision, description });
  }
  return [...entries.values()].sort((a, b) => b.api - a.api || (b.minor ?? 0) - (a.minor ?? 0) || (b.extension ?? 0) - (a.extension ?? 0)
    || a.device.localeCompare(b.device) || a.tag.localeCompare(b.tag) || a.abi.localeCompare(b.abi));
}

/** Docker tag of the farm image for one system image: 34-google_apis-x86_64, 36.1-google_apis_playstore-x86_64. */
export function imageTag(entry) {
  const api = String(entry.api) + (entry.minor != null ? '.' + entry.minor : '') + (entry.extension != null ? '-ext' + entry.extension : '');
  return `${api}-${entry.tag}-${entry.abi}`.replace(/[^A-Za-z0-9_.-]/g, '-');
}

/**
 * Images worth building for one host ABI. Extension builds (android-34-ext10) duplicate the base API and are skipped
 * unless asked; old APIs without an x86_64 build fall back to x86 on x86_64 hosts.
 */
export function selectEntries(catalog, { abi = 'x86_64', filter = null, extensions = false } = {}) {
  const pattern = filter ? new RegExp(filter) : null;
  const wanted = catalog.filter(entry => (extensions || entry.extension == null) && !entry.pageSize16k);
  const keys = new Set(wanted.filter(entry => entry.abi === abi).map(entry => `${entry.api}.${entry.minor}|${entry.tag}`));
  return wanted.filter(entry => entry.abi === abi
    || (abi === 'x86_64' && entry.abi === 'x86' && !keys.has(`${entry.api}.${entry.minor}|${entry.tag}`)))
    .filter(entry => !pattern || pattern.test(entry.package) || pattern.test(imageTag(entry)));
}

const DEVICE_NAMES = { phone: '', tablet: agentMessage('agent.profile.tabletName', { p0: '' }, 'ru'), tv: 'Android TV · ', automotive: 'Android Automotive · ', wear: 'Wear OS · ', desktop: 'Desktop · ' };
const FLAVOR_NAMES = { google_play: 'Google Play', google_apis: 'Google APIs', aosp: 'AOSP' };
const SYSTEM_IMAGE_NAMES = {
  default: 'AOSP', aosp_atd: 'AOSP ATD', google_atd: 'Google APIs ATD',
  google_apis: 'Google APIs', google_apis_playstore: 'Google Play',
  'android-tv': 'AOSP', 'google-tv': 'Google Play',
  'android-automotive': 'AOSP', 'android-automotive-playstore': 'Google Play',
  'android-wear': 'Google Play',
};

/** Preserve the system-image variant in saved profile names, including future SDK tags. */
export function systemImageName(entry) {
  return SYSTEM_IMAGE_NAMES[entry.tag] ?? `${FLAVOR_NAMES[entry.flavor]} · ${entry.tag}`;
}

const SCREENS = { phone: '1080x2400', tablet: '2560x1600', tv: '1920x1080', automotive: '1408x792', wear: '454x454', desktop: '1920x1080' };
const MODELS = { phone: 'Phone', tablet: 'Tablet', tv: 'TV 1080p', automotive: 'Automotive', wear: 'Wear round', desktop: 'Desktop' };
const DEVICE_TYPES = { phone: 'mobile', tablet: 'mobile', tv: 'tv', automotive: 'automotive', wear: 'wear', desktop: 'desktop' };

/** Resources by API level and form factor: Android memory inside a container limit that leaves 2 GiB for the emulator. */
function resources(entry, device) {
  const small = device === 'wear' || entry.api <= 25;
  const guestMemoryMb = small ? 2048 : device === 'tablet' || device === 'desktop' || entry.api >= 33 ? 4096 : 3072;
  return { cpu: 4, memoryMb: guestMemoryMb + 2048, guestMemoryMb, guestCores: !small && entry.api >= 33 ? 4 : 2,
    diskGb: small ? 4 : 8, diskMaxGb: 32,
    // No SD card by default; phones and tablets may ask for one at launch.
    ...(device === 'phone' || device === 'tablet' ? { sdcardMaxGb: 8 } : {}) };
}

/** Profile manifest (version 2) for the server's profile import. New profiles arrive disabled; enable the ones you built. */
export function buildManifest(catalog, { registry = 'rdf-emulator', abi = 'x86_64', filter = null, extensions = false } = {}) {
  const entries = selectEntries(catalog, { abi, filter, extensions });
  const profiles = [];
  const newestPhoneApi = Math.max(0, ...entries.filter(entry => entry.device === 'phone' && entry.flavor === 'google_play').map(entry => entry.api));
  for (const entry of entries) {
    const devices = entry.device === 'phone' && entry.api >= 28 ? ['phone', 'tablet'] : [entry.device];
    for (const device of devices) {
      const tag = imageTag(entry);
      const apiLabel = String(entry.api) + (entry.minor != null ? '.' + entry.minor : '') + (entry.extension != null ? ', ext ' + entry.extension : '');
      profiles.push({
        id: ('emu-' + tag + (device === 'tablet' ? '-tablet' : '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64),
        name: `${DEVICE_NAMES[device]}Android ${entry.androidVersion} · ${systemImageName(entry)} (API ${apiLabel})`,
        recommended: device === 'phone' && entry.flavor === 'google_play' && entry.api === newestPhoneApi,
        image: { repository: registry, tag },
        android: { version: entry.androidVersion, api: entry.api, abi: entry.abi, flavor: entry.flavor,
          deviceType: DEVICE_TYPES[device], deviceModel: MODELS[device], resolution: SCREENS[device] },
        resources: resources(entry, device),
        emulator: { params: [] },
      });
    }
  }
  return { version: 2, profiles };
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (name === 'extensions') options.extensions = true;
    else options[name] = argv[++i];
  }
  return options;
}

async function stdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const options = args(rest);
  const input = await stdin();
  if (command === 'parse') process.stdout.write(JSON.stringify(parseSdkList(input), null, 2) + '\n');
  else if (command === 'select') {
    for (const entry of selectEntries(JSON.parse(input), options)) process.stdout.write(`${entry.package}\t${imageTag(entry)}\n`);
  } else if (command === 'manifest') process.stdout.write(JSON.stringify(buildManifest(JSON.parse(input), options), null, 2) + '\n');
  else { process.stderr.write('usage: emulator-catalog.mjs parse|select|manifest [--abi x86_64] [--filter REGEX] [--registry NAME] [--extensions]\n'); process.exit(2); }
}
