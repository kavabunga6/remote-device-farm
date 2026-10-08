import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicit public source files only: never copy working directories, secrets or dependencies.
export const downloadFiles = [
  'scripts/rdf.sh',
  'examples/maestro/settings-smoke.yaml',
  'examples/jenkins/Jenkinsfile',
  'examples/jenkins/android-tests.sh',
  'examples/teamcity/run-tests.sh',
  'examples/teamcity/android-tests.sh',
  'examples/appium/package.json',
  'examples/appium/package-lock.json',
  'examples/appium/client.mjs',
  'examples/appium/process.mjs',
  'examples/appium/run.mjs',
  'examples/appium/settings.test.mjs',
];

export async function prepareDownloads(docsRoot) {
  const repositoryRoot = path.dirname(docsRoot);
  const destinationRoot = path.join(docsRoot, 'public/downloads');
  for (const file of downloadFiles) {
    const destination = path.join(destinationRoot, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, file), destination);
  }
  for (const directory of new Set(downloadFiles.map(file => path.posix.dirname(file)))) {
    const files = downloadFiles.filter(file => path.posix.dirname(file) === directory);
    const links = files.map(file => `<li><a href="./${path.posix.basename(file)}" download>${path.posix.basename(file)}</a></li>`).join('');
    await writeFile(path.join(destinationRoot, directory, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${directory} — примеры Device Farm</title><style>body{font:16px/1.7 system-ui;max-width:760px;margin:48px auto;padding:0 24px;color:#1c3138}a{color:#16735e}li{padding:6px}</style><h1>${directory}</h1><p>Скачайте все файлы в один каталог, сохранив имена. Здесь находятся исходники из текущей сборки документации.</p><ul>${links}</ul><a href="/ci/">К руководствам интеграций</a></html>`, 'utf8');
  }
}
