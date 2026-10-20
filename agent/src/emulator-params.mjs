const switches = new Set([
  '-no-snapshot', '-no-snapshot-load', '-no-snapshot-save', '-no-boot-anim',
  '-wipe-data', '-no-audio', '-noaudio', '-no-window', '-no-cache', '-nocache',
  '-show-kernel', '-verbose', '-no-metrics',
]);
const networkNames = ['gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo'];

function boundedRange(value, min, max, ordered = true) {
  if (!/^\d+(?::\d+)?$/.test(value)) return false;
  const numbers = value.split(':').map(Number);
  return numbers.every((number) => Number.isInteger(number) && number >= min && number <= max) &&
    (!ordered || numbers.length === 1 || numbers[0] <= numbers[1]);
}

const values = {
  '-timezone': (value) => /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(value),
  '-change-language': (value) => /^[A-Za-z]{2,3}$/.test(value),
  '-change-country': (value) => /^[A-Za-z]{2}$/.test(value),
  '-netdelay': (value) => [...networkNames, 'none'].includes(value) || boundedRange(value, 0, 60000),
  '-netspeed': (value) => [...networkNames, 'full'].includes(value) || boundedRange(value, 1, 1000000, false),
  '-camera-back': (value) => ['emulated', 'none', 'environment', 'virtualscene'].includes(value),
  '-camera-front': (value) => ['emulated', 'none', 'environment'].includes(value),
  '-screen': (value) => ['touch', 'multi-touch', 'no-touch'].includes(value),
};

// These arguments reach Google's launcher as EMULATOR_PARAMS. Keep this allowlist
// aligned with the API validator; never allow paths, QEMU passthrough or host flags.
export function validateEmulatorParams(input) {
  if (typeof input !== 'string' || input.length > 500 || /[^A-Za-z0-9_+:/ .-]/.test(input)) {
    throw new Error('Invalid EMULATOR_PARAMS: use supported emulator arguments, up to 500 characters');
  }
  const tokens = input.trim() ? input.trim().split(/ +/) : [];
  const seen = new Set();
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    const canonical = ({ '-noaudio': '-no-audio', '-nocache': '-no-cache' })[flag] || flag;
    if (seen.has(canonical)) throw new Error(`Duplicate emulator argument: ${flag}`);
    seen.add(canonical);
    if (switches.has(flag)) continue;
    const validate = Object.hasOwn(values, flag) ? values[flag] : null;
    if (!validate) throw new Error(`Unsupported emulator argument: ${flag}`);
    const value = tokens[++index];
    if (!value || !validate(value)) throw new Error(`Invalid value for emulator argument ${flag}`);
  }
  return tokens.join(' ');
}
