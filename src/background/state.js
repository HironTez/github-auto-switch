// Settings and saved sign-ins, cached for the background. The background saves sign-ins ("sessions")
// one write at a time; the settings page only removes them through it.

import { loadSessions, loadSettings } from "../lib/storage.js";

let settingsCache = null;
let sessionsCache = null;

// A failed read is not cached: the next call tries again.
const retryOnFailure = (promise, forget) =>
  promise.catch((error) => {
    forget();
    throw error;
  });

export const getSettings = () => (settingsCache ??= retryOnFailure(loadSettings(), () => (settingsCache = null)));
export const getSessions = () => (sessionsCache ??= retryOnFailure(loadSessions(), () => (sessionsCache = null)));

/** storage.onChanged listener: drops what another page (or this one) changed. */
export function forgetChanged(changes) {
  if ("settings" in changes) settingsCache = null;
  if ("sessions" in changes) sessionsCache = null;
}

let sessionWrites = Promise.resolve();

/**
 * Changes the saved sign-ins. `mutate` (may be async) edits them in place and returns:
 * - false: nothing changed;
 * - { alsoSave, onSaved }: more storage.local keys to write in the same write (the vault, when its
 *   keys change with the sign-ins), and what to do once written (before the next change starts);
 * - anything else: save.
 * Errors reach the caller; later writes still run.
 */
export function updateSessions(mutate) {
  const run = sessionWrites.then(async () => {
    const sessions = await loadSessions();
    const result = await mutate(sessions);
    if (result === false) return;
    await chrome.storage.local.set({ sessions, ...result?.alsoSave });
    sessionsCache = Promise.resolve(sessions);
    await result?.onSaved?.();
  });
  sessionWrites = run.catch(() => {});
  return run;
}
