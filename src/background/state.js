// Settings and saved sign-ins, cached for the background. The background saves sign-ins ("sessions")
// one write at a time; the settings page only removes them through it.

import { loadSessions, loadSettings, saveSessions } from "../lib/storage.js";

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
 * Changes the saved sign-ins. `mutate` edits them in place; returning false means nothing changed.
 * Errors reach the caller; later writes still run.
 */
export function updateSessions(mutate) {
  const run = sessionWrites.then(async () => {
    const sessions = await loadSessions();
    if (mutate(sessions) === false) return;
    await saveSessions(sessions);
    sessionsCache = Promise.resolve(sessions);
  });
  sessionWrites = run.catch(() => {});
  return run;
}
