// Public runtime settings are useful diagnostics. All other environment values stay private.
const PUBLIC_ENV_NAMES = new Set([
  'HOME', 'PATH', 'HOSTNAME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'TERM',
  'LD_LIBRARY_PATH', 'LIBRARY_PATH', 'DISPLAY', 'XDG_RUNTIME_DIR',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_AVD_HOME',
  'RDF_RAM_MB', 'RDF_CORES', 'RDF_DATA_MB', 'RDF_SDCARD_MB', 'RDF_SD_CARD_MB',
  'RDF_DEVICE', 'RDF_SCREEN', 'RDF_DENSITY', 'RDF_GPU', 'RDF_SYSTEM_IMAGE',
  'NVIDIA_VISIBLE_DEVICES', 'NVIDIA_DRIVER_CAPABILITIES', 'NVIDIA_REQUIRE_CUDA', 'CUDA_VERSION',
]);
export function diagnosticSecrets(env = []) {
  return (env || []).flatMap(entry => {
    const separator = entry.indexOf('=');
    if (separator < 1) return [];
    const name = entry.slice(0, separator), value = entry.slice(separator + 1);
    if (PUBLIC_ENV_NAMES.has(name)) return [];
    return /^(ADBKEY|ADBKEY_PUB)$/.test(name) ? [value, value.trim().split(/\s+/)[0]] : [value];
  });
}
export function diagnosticSeverity(line, stream = 'stdout') {
  const text = String(line).replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimStart();
  const level = text.match(/^(?:\[(ERROR|FATAL|PANIC|WARNING|WARN|USER_WARNING|INFO|DEBUG|VERBOSE)\]|(ERROR|FATAL|PANIC|WARNING|WARN|USER_WARNING|INFO|DEBUG|VERBOSE)\s*[|:])/i);
  if (level) {
    const value = (level[1] || level[2]).toUpperCase();
    if (['ERROR', 'FATAL', 'PANIC'].includes(value)) return 'error';
    if (['WARNING', 'WARN', 'USER_WARNING'].includes(value)) return 'warning';
    return 'info';
  }
  // A component can warn without terminating the emulator; do not infer a failed session from wording.
  if (/^[\w.-]+:\s*(?:failed|unable|error)\b/i.test(text)) return 'warning';
  return stream === 'stderr' ? 'warning' : 'info';
}
// Never persist credentials or keys in container diagnostics.
export function redactDiagnostic(value, secrets = []) {
  let text = String(value ?? '').replace(/-----BEGIN [\s\S]*?-----END [^\n]+-----/g, '[redacted key]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:rdf_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/((?:password|passwd|secret|token|authorization|cookie|api[_-]?key|adbkey(?:_pub)?|private[_-]?key)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  return text.slice(0, 4096);
}
export function diagnosticReporter(onLog, secrets = []) {
  return (code, message, severity = 'info', service = 'agent') => {
    if (typeof onLog !== 'function') return;
    try {
      const result = onLog({ code, message: redactDiagnostic(message, secrets), severity, service });
      return result?.catch ? result.catch(() => {}) : result;
    }
    catch { /* Diagnostics must not prevent teardown. */ }
  };
}
export function dockerLogLines(buffer, tty = false) {
  if (tty) return [{ stream: 'stdout', text: buffer.toString('utf8') }];
  const chunks = { stdout: [], stderr: [] };
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const kind = buffer[offset], length = buffer.readUInt32BE(offset + 4);
    if (![1, 2].includes(kind) || offset + 8 + length > buffer.length) throw new Error('Invalid Docker log stream');
    chunks[kind === 2 ? 'stderr' : 'stdout'].push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  if (offset !== buffer.length) throw new Error('Incomplete Docker log stream');
  return Object.entries(chunks).map(([stream, parts]) => ({ stream, text: Buffer.concat(parts).toString('utf8') }));
}
