import { uiMessage } from './messages.js';
import { ApiError } from './http-common.js';

export function assertProfileHostArchitecture(profile: { abi?: unknown }, metrics: { architecture?: unknown } = {}): void {
  const arch = typeof metrics.architecture === 'string' ? metrics.architecture.toLowerCase() : '';
  const allowed = ['x64', 'x86_64', 'amd64'].includes(arch) ? ['x86', 'x86_64'] : ['arm64', 'aarch64'].includes(arch) ? ['arm64-v8a'] : null;
  const abis = typeof profile.abi === 'string' ? profile.abi.split(',').map(value => value.trim()).filter(Boolean) : [];
  // Custom/legacy images without declared guest ABI keep their existing behavior.
  if (allowed && abis.length && !abis.some(abi => allowed.includes(abi))) {
    throw new ApiError(409, 'profile_architecture_unsupported', uiMessage('ui.9afaeffdfe25', {}, 'en'));
  }
}
