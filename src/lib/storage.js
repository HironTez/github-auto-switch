// Storage layout shared by the background, popup and options pages.
//
// storage.sync  "settings": rules and options (small, follows the user's browser profile sync)
// storage.local "sessions": { [login lowercased]: { login, sealed, tokenHash, fingerprint, updatedAt, stale } }
//                           The cookies are encrypted ("sealed", background/vault.js) and never leave
//                           this device.
// storage.local "vault":    the key that seals them (background/vault.js)
// storage.local "status":   { problem: string | null, at: number }
// storage.local "activity": the activity log, when turned on (background/log.js)
// storage.session "accountHistory", "skippedTabs": the background's memory across restarts of it
//                           (background/history.js, background/switching.js)
// storage.session "vaultKey": the unlocked key, with a passphrase set (background/vault.js)
// storage.session "unlockAsked": the unlock page was opened for this browser session (background.js)

import { normalizeSettings } from "./rules.js";

async function syncOrLocal(op) {
  try {
    return await op(chrome.storage.sync);
  } catch {
    // Sync storage can be unavailable (disabled by policy, some Safari setups).
    return op(chrome.storage.local);
  }
}

export async function loadSettings() {
  const { settings } = await syncOrLocal((area) => area.get("settings"));
  return normalizeSettings(settings);
}

export function saveSettings(settings) {
  return syncOrLocal((area) => area.set({ settings: normalizeSettings(settings) }));
}

export async function loadSessions() {
  const { sessions } = await chrome.storage.local.get("sessions");
  return sessions && typeof sessions === "object" ? sessions : {};
}

export async function loadStatus() {
  const { status } = await chrome.storage.local.get("status");
  return status ?? { problem: null, at: 0 };
}
