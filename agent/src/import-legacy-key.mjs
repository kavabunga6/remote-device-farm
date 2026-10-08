import { chmod, chown, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function existing(pathname) {
  try { return await lstat(pathname); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function keyBytes(pathname) {
  const detail = await lstat(pathname);
  if (!detail.isFile() || detail.size < 1 || detail.size > 16 * 1024) {
    throw new Error('Invalid legacy ADB key file');
  }
  return readFile(pathname);
}

export async function importLegacyKeys({
  privateSource = '/legacy-adbkey',
  publicSource = '/legacy-adbkey.pub',
  destinationDir = '/home/agent/.android',
  owner = { uid: 10001, gid: 10001 },
} = {}) {
  const [privateBytes, publicBytes] = await Promise.all([
    keyBytes(privateSource), keyBytes(publicSource),
  ]);
  const directory = await lstat(destinationDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid ADB key destination');
  const privateTarget = path.join(destinationDir, 'adbkey');
  const publicTarget = path.join(destinationDir, 'adbkey.pub');
  const [privateCurrent, publicCurrent] = await Promise.all([
    existing(privateTarget), existing(publicTarget),
  ]);
  if (privateCurrent || publicCurrent) {
    if (!privateCurrent?.isFile() || !publicCurrent?.isFile()) {
      throw new Error('Partial ADB key import; refusing to overwrite');
    }
    const [installedPrivate, installedPublic] = await Promise.all([
      readFile(privateTarget), readFile(publicTarget),
    ]);
    if (!installedPrivate.equals(privateBytes) || !installedPublic.equals(publicBytes)) {
      throw new Error('Existing ADB key differs from legacy source; refusing to replace');
    }
    if (owner && (directory.uid !== owner.uid || directory.gid !== owner.gid ||
        privateCurrent.uid !== owner.uid || privateCurrent.gid !== owner.gid ||
        publicCurrent.uid !== owner.uid || publicCurrent.gid !== owner.gid ||
        (directory.mode & 0o777) !== 0o700 ||
        (privateCurrent.mode & 0o777) !== 0o600 ||
        (publicCurrent.mode & 0o777) !== 0o644)) {
      throw new Error('Imported ADB key permissions are unsafe');
    }
    return { imported: false };
  }
  if (owner) {
    await chown(destinationDir, 0, 0);
    await chmod(destinationDir, 0o700);
  }
  let createdPrivate = false;
  let createdPublic = false;
  try {
    await writeFile(privateTarget, privateBytes, { flag: 'wx', mode: 0o600 });
    createdPrivate = true;
    await writeFile(publicTarget, publicBytes, { flag: 'wx', mode: 0o644 });
    createdPublic = true;
    const [installedPrivate, installedPublic] = await Promise.all([
      readFile(privateTarget), readFile(publicTarget),
    ]);
    if (!installedPrivate.equals(privateBytes) || !installedPublic.equals(publicBytes)) {
      throw new Error('ADB key copy verification failed');
    }
    await chmod(privateTarget, 0o600);
    await chmod(publicTarget, 0o644);
    if (owner) {
      await chown(privateTarget, owner.uid, owner.gid);
      await chown(publicTarget, owner.uid, owner.gid);
      await chown(destinationDir, owner.uid, owner.gid);
    }
    return { imported: true };
  } catch (error) {
    await Promise.allSettled([
      createdPrivate ? rm(privateTarget, { force: true }) : Promise.resolve(),
      createdPublic ? rm(publicTarget, { force: true }) : Promise.resolve(),
    ]);
    if (owner) await chown(destinationDir, owner.uid, owner.gid).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await importLegacyKeys();
  console.log('Legacy ADB identity is ready');
}
