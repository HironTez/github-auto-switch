// A problem the user should know about (a switch that keeps failing, a sign-in GitHub no longer
// accepts): shown in the popup and on the settings page, and as "!" on the toolbar icon. While the
// saved sign-ins are locked, the icon shows a lock instead.

import { loadStatus } from "../lib/storage.js";
import { isLocked } from "./vault.js";

export async function setProblem(problem) {
  await chrome.storage.local.set({ status: { problem, at: Date.now() } });
  await refreshBadge();
}

export async function clearProblem() {
  if ((await loadStatus()).problem) await setProblem(null);
}

/** Shows on the toolbar icon whether the extension is locked or has a problem. */
export async function refreshBadge() {
  const locked = await isLocked().catch(() => false);
  const problem = !locked && (await loadStatus()).problem;
  await chrome.action.setBadgeText({ text: locked ? "🔒" : problem ? "!" : "" });
  if (locked || problem) await chrome.action.setBadgeBackgroundColor({ color: locked ? "#59636e" : "#d1242f" });
  await chrome.action.setTitle?.({ title: locked ? "GitHub Auto Switch: locked" : "GitHub Auto Switch" });
}
