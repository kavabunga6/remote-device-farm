import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanner = process.argv[2];
assert.ok(scanner, 'Pass the Gitleaks executable path');
const directory = mkdtempSync(join(tmpdir(), 'rdf-secret-scanner-'));
const diagnostic = Object.keys(JSON.parse(readFileSync(join(root, 'shared/diagnostics.json'), 'utf8'))).find(key => key.startsWith('adb-wire.'));
assert.ok(diagnostic);
const cases = [
  { file: 'shared/locales/es.json', value: diagnostic, detected: false },
  { file: 'shared/locales/es.json', value: randomBytes(32).toString('hex'), detected: true },
  { file: 'settings.json', value: diagnostic, detected: true },
];
try {
  for (const [index, item] of cases.entries()) {
    const sample = join(directory, String(index));
    const file = join(sample, item.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ api_key: item.value }, null, 2));
    const report = join(directory, `report-${index}.json`);
    const result = spawnSync(scanner, ['dir', '--no-banner', '--redact=100', '--config', join(root, '.gitleaks.toml'), '--report-format', 'json', '--report-path', report, '.'], { cwd: sample, encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, item.detected ? 1 : 0, `Scanner boundary case ${index}: ${result.stderr}`);
    const findings = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(findings.length > 0, item.detected, `Scanner boundary case ${index}`);
  }
  console.log('Secret scanner: generated IDs scoped; canary credentials and other files still detected');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
