// Runs as a service worker in Chromium/Safari and as an event page in Firefox.
// Use the `chrome.*` namespace: every target browser supports it with promises in MV3.

chrome.runtime.onInstalled.addListener(async () => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled === undefined) {
    await chrome.storage.local.set({ enabled: true });
  }
});
