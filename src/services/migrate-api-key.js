/**
 * One-time legacy API key migration — storage injected, no chrome imports.
 * Legacy installs stored the provider key under `geminiApiKey`; the current
 * code reads `providerApiKey` only. Run once at startup:
 *   geminiApiKey present + providerApiKey empty → copy to providerApiKey,
 *   then always delete the legacy key. Never throws.
 * @module services/migrate-api-key
 */

export const LEGACY_GEMINI_API_KEY = 'geminiApiKey';

/**
 * @param {{get: Function, set: Function, remove?: Function}} storage
 *   chrome.storage.local-like adapter with promise API.
 * @returns {Promise<{migrated: boolean, copied: boolean, error?: string}>}
 *   migrated: legacy key was present (and has been removed).
 *   copied:   its value was copied into providerApiKey.
 */
export async function migrateLegacyApiKey(storage) {
  try {
    const res = await storage.get([LEGACY_GEMINI_API_KEY, 'providerApiKey']);
    const legacy = typeof res?.[LEGACY_GEMINI_API_KEY] === 'string' ? res[LEGACY_GEMINI_API_KEY] : '';
    if (!legacy.trim()) return { migrated: false, copied: false };
    const current = typeof res?.providerApiKey === 'string' ? res.providerApiKey : '';
    let copied = false;
    if (!current.trim()) {
      await storage.set({ providerApiKey: legacy });
      copied = true;
    }
    if (typeof storage.remove === 'function') {
      await storage.remove([LEGACY_GEMINI_API_KEY]);
    } else {
      // fallback: blank the legacy key when remove is unavailable
      await storage.set({ [LEGACY_GEMINI_API_KEY]: '' });
    }
    return { migrated: true, copied };
  } catch (e) {
    return { migrated: false, copied: false, error: String(e) };
  }
}
