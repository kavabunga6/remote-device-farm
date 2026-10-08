export const IMAGE_CHECK_VERSION = 1;
const evidenceKeys = ['bootCompleted','adbSecure','unauthorizedAdb','rendererVerified','deviceVerified','resourcesVerified'];
export function completeImageCheck(value: unknown): boolean {
  const result = value as {version?:unknown;checks?:{off?:Record<string,unknown>}} | null;
  return result?.version === IMAGE_CHECK_VERSION && Boolean(result?.checks?.off) && Object.values(result?.checks??{}).every(check=>evidenceKeys.every(key=>check?.[key]===true));
}
