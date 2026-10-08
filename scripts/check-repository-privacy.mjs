import { readRepositoryFiles } from './repository-files.mjs';
import { isIP } from 'node:net';
import assert from 'node:assert/strict';

const reportFile = /^(?:deploy\/(?:emulator|hqarroum-emulator)\/(?:verified|pipeline|input-latency)[^/]*\d{8}\.json|docs\/security\/(?:deployment|install-restore)-\d{8}\.json)$/;
const publicExample = /^(?:docs\/|deploy\/|frontend\/dev\/|\.env\.)/;
const privateAddress = address => {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

export function checkText(file, text) {
  const reasons = [];
  const paths = text.replaceAll('/android-home/home/.android', '');
  if (/[A-Z]:[\\/]+(?:Users|development|projects)[\\/]/i.test(paths) || /\/Users\/[^/\s]+\/|\/home\/(?!agent\/|\.android\b)[^/\s]+\//.test(paths)) reasons.push('personal filesystem path');
  if (reportFile.test(file) && /"(?:sessionId|containerId|imageId|adapterImageId|sourceCommit|sourceRevision|backupHashes|releaseIncident|deployment|rollback)"\s*:/.test(text)) reasons.push('deployment identifiers in a public report');
  if (publicExample.test(file) && !file.includes('package-lock.json') && !file.includes('dependency-licenses.json') && !file.startsWith('deploy/firewall/')) {
    const addresses = text.match(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g) || [];
    // Android's documented emulator subnet is protocol fixture data.
    if (addresses.some(address => privateAddress(address) && !['10.0.2.15', '10.0.2.255'].includes(address))) reasons.push('private IP in documentation or demo data');
  }
  if (file === 'frontend/dev/mock-api.mjs') {
    for (const model of text.matchAll(/(?:cpuModel|gpuModel):\s*'([^']+)'/g)) {
      if (!model[1].includes('Example')) reasons.push('hardware inventory in demo data');
    }
  }
  return [...new Set(reasons)];
}

function checkPng(file, data) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!data.subarray(0, 8).equals(signature)) throw new Error(file + ': invalid PNG');
  for (let offset = 8; offset < data.length;) {
    if (offset + 12 > data.length) throw new Error(file + ': truncated PNG');
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) throw new Error(file + ': screenshot metadata');
    if (offset + length + 12 > data.length) throw new Error(file + ': invalid PNG chunk');
    offset += length + 12;
  }
}

if (process.argv.includes('--self-test')) {
  assert.deepEqual(checkText('README.md', ['C:', 'Users', 'example', 'Documents', 'log.txt'].join('/')), ['personal filesystem path']);
  assert.deepEqual(checkText('docs/example.md', 'https://192.168.50.20'), ['private IP in documentation or demo data']);
  assert.deepEqual(checkText('docs/example.md', 'https://192.0.2.20'), []);
  assert.deepEqual(checkText('deploy/emulator/verified-image-20261007.json', '{"sessionId":"example"}'), ['deployment identifiers in a public report']);
  assert.deepEqual(checkText('frontend/dev/mock-api.mjs', "cpuModel: 'Example CPU'"), []);
  assert.deepEqual(checkText('frontend/dev/mock-api.mjs', "cpuModel: 'Real host model'"), ['hardware inventory in demo data']);
  assert.deepEqual(checkText('server/src/routes/example.ts', "'/api/admin/users/123/password'"), []);
  assert.deepEqual(checkText('compose.agent.yaml', '/home/agent/.android'), []);
  assert.deepEqual(checkText('agent/Dockerfile', '/android-home/home/.android'), []);
  console.log('9 privacy guard cases passed');
} else {
  const staged = process.argv.includes('--staged');
  const repository = readRepositoryFiles(staged);
  const failures = [];
  let screenshots = 0;
  for (const [file, data] of repository) {
    if (/(?:^|\/)(?:\.env(?:\..+)?|adbkey(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|crt))$/i.test(file) && !/^\.env\.(?:agent\.)?example$/.test(file)) failures.push(file + ': sensitive file');
    if (file.startsWith('docs/screenshots/') && file.endsWith('.png')) { checkPng(file, data); screenshots++; }
    if (data.includes(0)) continue;
    for (const reason of checkText(file, data.toString('utf8'))) failures.push(file + ': ' + reason);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`${staged ? 'Staged: ' : ''}${repository.size} files; ${screenshots} screenshot metadata checked`);
}
