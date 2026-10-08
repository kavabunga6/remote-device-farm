// Serialize operations for the same resource without blocking unrelated resources.
// Rejection never poisons a queue, and only the last owner removes its entry.
export function runKeyed(queue, key, work) {
  const previous = queue.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  queue.set(key, current);
  current.finally(() => { if (queue.get(key) === current) queue.delete(key); }).catch(() => {});
  return current;
}
