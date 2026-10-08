import { uiMessage } from './messages.js';
import { ApiError } from './http-common.js';

/** Accept only bounded, single-line profile text; empty values clear optional fields. */
export function profileField(value: unknown, max = 150): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_profile', uiMessage('ui.47b472faf066', {}, 'en'));
  const trimmed = value.trim();
  if (trimmed.length > max || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new ApiError(400, 'invalid_profile', uiMessage('ui.47b472faf066', {}, 'en'));
  }
  return trimmed || null;
}
