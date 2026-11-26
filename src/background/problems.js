// A problem the user should know about (a switch that keeps failing, a sign-in GitHub no longer
// accepts): shown in the popup and on the settings page, and as "!" on the toolbar icon.

import { loadStatus } from "../lib/storage.js";

export async function setProblem(problem) {
  await chrome.storage.local.set({ status: { problem, at: Date.now() } });
  await showBadge(problem);
}

export async function clearProblem() {
  if ((await loadStatus()).problem) await setProblem(null);
}

export async function showBadge(problem) {
  await chrome.action.setBadgeText({ text: problem ? "!" : "" });
  if (problem) await chrome.action.setBadgeBackgroundColor({ color: "#d1242f" });
}
