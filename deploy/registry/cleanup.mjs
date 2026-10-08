import { validateRemoval } from './storage.mjs';
/** Always stop Distribution before mark-and-sweep and restart it even when GC fails. */
export async function runCleanup({ job, drain, inventory, remove, stop, gc, restart, save }) {
  job.state = 'running'; job.stage = 'draining'; await save();
  await drain();
  const snapshot = await inventory();
  if (snapshot.repositories.some(repo => repo !== 'rdf-emulator')) throw new Error('Shared registry cannot be collected');
  validateRemoval(snapshot.items, job.digests);
  job.stage = 'deleting'; await save();
  for (const digest of job.digests) { await remove(digest); job.deleted.push(digest); await save(); }
  job.stage = 'collecting'; await save();
  await stop();
  try { await gc(); } finally { await restart(); }
  job.state = 'done'; job.stage = 'done';
}
