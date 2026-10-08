import { resolve, dirname, relative, sep } from 'node:path';
import assert from 'node:assert/strict';
import { repositoryRoot as root, readRepositoryFiles } from './repository-files.mjs';

const rejected = /(?:\b(?:delve|leverage|foster|seamless|effortless|embark|streamline|elevate|it is worth noting)\b|важно отметить|стоит отметить|в рамках этой работы|по вашему запросу|как вы просили|как мы договорились|с вашего разрешения|из нашего диалога|обсуждали с вами|пользователь подтвердил|отложен[а-я]* владельцем|All six stages|outside this task)/iu;

export function isInternalArtifact(file) {
  return /(?:^|\/)(?:TODO[^/]*\.md|AGENTS\.md|CLAUDE\.md)$/i.test(file)
    || /(?:^|\/)(?:\.claude|\.codex|\.agents|private-reports|publication-review-private)\//i.test(file)
    || /^docs\/(?:release-readiness[^/]*\.md|maintenance-audit\.md|guides\/(?:pipeline-latency|network-isolation-test)\.md|security\/(?:deployment|install-restore)-[^/]+\.json)$/i.test(file)
    || /^deploy\/(?:emulator\/(?:verified-image|input-latency)-[^/]+\.json|emulator\/google-starter\.json|hqarroum-emulator\/(?:pipeline-verification|verified-images)-[^/]+\.json)$/i.test(file);
}

if (process.argv.includes('--self-test')) {
  for (const file of ['TODO.MD', 'TODO-CHECKS.md', 'docs/TODO.md', 'AGENTS.md', '.claude/settings.json', 'docs/security/deployment-20990101.json', 'deploy/emulator/input-latency-20990101.json']) assert.equal(isInternalArtifact(file), true, file);
  for (const file of ['docs/verification.md', 'docs/security/dependency-licenses.json', 'agent/src/agent-control.test.mjs']) assert.equal(isInternalArtifact(file), false, file);
  for (const text of ['Как вы просили, исправлено.', 'С вашего разрешения изменена конфигурация.', 'The workaround is outside this task.']) assert.equal(rejected.test(text), true, text);
  for (const text of ['Пользователь подтверждает удаление сессии.', 'The service checks session ownership.', 'Keep conversation records outside version control.']) assert.equal(rejected.test(text), false, text);
  console.log('16 public-content guard cases passed');
} else {
  const staged = process.argv.includes('--staged');
  const repository = readRepositoryFiles(staged);
  const failures = [];
  const read = file => {
    const data = repository.get(file);
    if (!data) throw new Error(file + ': required public file is missing');
    return data;
  };
  const files = [...repository.keys()].filter(file => file.toLowerCase().endsWith('.md') && !file.startsWith('docs/licenses/'));
  for (const file of repository.keys()) if (isInternalArtifact(file)) failures.push(file + ': local notes or internal report cannot be committed');
  let links = 0;
  for (const file of files) {
    const text = read(file).toString('utf8');
    if (rejected.test(text)) failures.push(file + ': conversational or promotional wording');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|data:|#)/i.test(target)) continue;
      const path = decodeURIComponent(target.split(/[?#]/)[0]);
      if (!path) continue;
      // Site-root URLs are checked by the documentation build.
      if (path.startsWith('/')) continue;
      const local = relative(root, resolve(root, dirname(file), path)).split(sep).join('/');
      const available = repository.has(local) || [...repository.keys()].some(file => file.startsWith(local + '/'));
      if (isInternalArtifact(local)) failures.push(file + ': link to local-only material ' + target);
      else if (!available) failures.push(file + ': link target is not part of the repository ' + target);
      links++;
    }
  }
  const dictionary = JSON.parse(read('shared/messages.json').toString('utf8'));
  for (const [key, values] of Object.entries(dictionary)) for (const text of Object.values(values)) {
    if (rejected.test(text)) failures.push('shared/messages.json: ' + key);
  }
  const manifest = JSON.parse(read('docs/screenshots/manifest.json').toString('utf8'));
  if (manifest.screens.length !== 8 || manifest.source !== 'Current UI with mock API and demo data') failures.push('Screenshot metadata is incomplete');
  let bytes = 0;
  for (const screen of manifest.screens) {
    if (screen.horizontalOverflow || screen.browserErrors.length) failures.push(screen.file + ': invalid capture');
    const data = read('docs/screenshots/' + screen.file);
    if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.readUInt32BE(16) !== 1600 || data.readUInt32BE(20) < 1000) failures.push(screen.file + ': invalid PNG dimensions');
    bytes += data.length;
  }
  if (!read('README.md').toString('utf8').includes('**Not tested**')) failures.push('README has no Not tested statuses');
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`${staged ? 'Staged: ' : ''}${files.length} documents, ${links} local links, ${Object.keys(dictionary).length} RU/EN entries, 8 screenshots (${(bytes / 1024 / 1024).toFixed(2)} MiB) checked`);
}
