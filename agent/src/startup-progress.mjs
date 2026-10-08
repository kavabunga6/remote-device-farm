const STAGES = new Set(['checking_image', 'waiting_image', 'downloading', 'creating', 'booting', 'ready']);
export function normalizeStartupProgress(value) {
  if (!value || !STAGES.has(value.stage)) throw new Error('Invalid startup progress stage');
  const progress = { stage: value.stage };
  for (const key of ['currentBytes', 'totalBytes']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) progress[key] = value[key];
  }
  if (Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) progress.percent = Math.round(value.percent);
  if (typeof value.detail === 'string') progress.detail = value.detail.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512);
  return progress;
}
export function progressReporter(emit = () => {}, { intervalMs = 250, now = Date.now } = {}) {
  let previousStage, last = -Infinity;
  return value => {
    const progress = normalizeStartupProgress(value), time = now();
    if (progress.stage === previousStage && time - last < intervalMs) return;
    previousStage = progress.stage; last = time; emit(progress);
  };
}
