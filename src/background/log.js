// Errors, and the activity log: what the extension saw and did, recorded while it is turned on in the
// settings (for troubleshooting). Kept in storage.local "activity", the last ACTIVITY_MAX entries, and
// shown on the settings page.

import { getSettings } from "./state.js";

const ACTIVITY_MAX = 300;
const FLUSH_DELAY_MS = 300;

let buffer = [];
let flushTimer = null;
let writes = Promise.resolve();

export function trace(event, details = {}) {
  getSettings().then((settings) => {
    if (!settings.activityLog) return;
    buffer.push({ at: Date.now(), event, ...details });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }, () => {});
}

function flush() {
  const entries = buffer;
  buffer = [];
  writes = writes
    .then(async () => {
      const { activity } = await chrome.storage.local.get("activity");
      const kept = Array.isArray(activity) ? activity : [];
      await chrome.storage.local.set({ activity: [...kept, ...entries].slice(-ACTIVITY_MAX) });
    })
    .catch((error) => console.error("[github-auto-switch] activity log not saved:", error));
}

export function log(...args) {
  console.error("[github-auto-switch]", ...args);
  trace("error", { message: args.map(String).join(" ") });
}
