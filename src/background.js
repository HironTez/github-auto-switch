// The background: runs as a module service worker in Chromium and Safari, and as a module event page in
// Firefox. Uses the `chrome.*` namespace, which every target browser supports with promises in MV3.
//
// How it works
// - Remembering (background/accounts.js): GitHub's sign-in lives in a few cookies. Whenever they change
//   to a signed-in account, a GitHub page loads signed in, or the popup opens, the extension keeps a
//   copy of them for that account.
// - Switching (background/switching.js): when a tab starts loading a github.com page, the rules
//   (lib/rules.js) pick an account. If it is not the signed-in one, the extension puts that account's
//   cookies in place (background/cookies.js) and restarts the load. A clicked link that needs another
//   account is switched before its page loads (content.js).
// - Checking: the content script reports which account the loaded page shows. A page with the wrong
//   account is switched and reloaded; if GitHub did not accept the saved sign-in, the account is marked
//   as signed out and the previous account is restored.
// - The tab in front (background/front.js): only the tab in front switches. Coming back to a GitHub
//   tab puts back the account its page shows, or reloads it if it loaded or sent requests with another
//   account meanwhile (background/history.js).
//
// Every listener is registered here, synchronously, as the browser needs to wake the background for
// its events.
//
// Browser differences
// - Safari before 18.4 has no webRequest for Manifest V3 extensions. Without it, the page check still
//   corrects a page that loaded with the wrong account, with one reload.
// - Safari documents no `types` filter for webRequest; listeners then check details.type themselves.
// - Safari has no webNavigation.onHistoryStateUpdated; the content script reports in-page navigation.

import { captureSession, onCookieChanged } from "./background/accounts.js";
import { onTabActivated, onTabComplete, onWindowFocused } from "./background/front.js";
import { log, trace } from "./background/log.js";
import { createMessageHandler } from "./background/messages.js";
import { refreshBadge } from "./background/problems.js";
import { forgetChanged, getSettings } from "./background/state.js";
import {
  forgetTab, handleNavigation, noteLoadStart, onMainFrameSettled, onTabLoaded, onTabLoading,
} from "./background/switching.js";
import { checkVault, forgetVault, shouldAskToUnlock } from "./background/vault.js";

const GITHUB_PAGES = ["https://github.com/*"];

chrome.storage.onChanged.addListener((changes, area) => {
  forgetChanged(changes);
  if (area === "local" && "vault" in changes) forgetVault();
});
// The unlocked key (vault.js) is for the background only, never for content scripts.
chrome.storage.session?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(log);
chrome.cookies.onChanged.addListener(onCookieChanged);

// ---------------------------------------------------------------------------------------------------
// Page loads

function onMainFrame(event, listener) {
  if (!event) return;
  const mainFrameOnly = (details) => {
    if (details.type === undefined || details.type === "main_frame") listener(details);
  };
  try {
    event.addListener(mainFrameOnly, { urls: GITHUB_PAGES, types: ["main_frame"] });
  } catch {
    event.addListener(mainFrameOnly, { urls: GITHUB_PAGES });
  }
}

onMainFrame(chrome.webRequest?.onBeforeRequest, (details) => {
  // tabId -1: prerendering and other requests without a visible tab. Non-GET: form submissions,
  // which a restart would turn into a GET. Undefined type: can't tell a page load from a fetch.
  if (details.tabId < 0 || details.method !== "GET" || details.type !== "main_frame") return;
  noteLoadStart(details.tabId);
  trace("page load starts", { tab: details.tabId, url: details.url });
  handleNavigation(details.tabId, details.url, { mode: "request", requestId: details.requestId }).catch(log);
});
if (chrome.webRequest?.onResponseStarted) {
  onMainFrame(chrome.webRequest.onResponseStarted, onMainFrameSettled);
  onMainFrame(chrome.webRequest.onErrorOccurred, onMainFrameSettled);
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") onTabLoading(tabId, tab);
  if (changeInfo.status !== "complete") return;
  if (!chrome.webRequest?.onResponseStarted) onTabLoaded(tabId);
  onTabComplete(tabId);
});

// GitHub pages only, like every listener here: the extension stays away from other sites. Also where
// webRequest is missing (Safari before 18.4). Loads outside github.com: tabs.onUpdated (onTabLoading).
const GITHUB_NAVIGATION = { url: [{ schemes: ["https"], hostEquals: "github.com" }] };
chrome.webNavigation?.onBeforeNavigate?.addListener((details) => {
  if (details.frameId === 0) noteLoadStart(details.tabId);
}, GITHUB_NAVIGATION);

// ---------------------------------------------------------------------------------------------------
// In-page navigation

function onInPageNavigation(tabId, url) {
  getSettings()
    .then((settings) => settings.inPageNavigation && handleNavigation(tabId, url, { mode: "history" }))
    .catch(log);
}

const historyEvents = chrome.webNavigation?.onHistoryStateUpdated;
historyEvents?.addListener(
  (details) => {
    if (details.frameId === 0) onInPageNavigation(details.tabId, details.url);
  },
  GITHUB_NAVIGATION,
);

// ---------------------------------------------------------------------------------------------------
// Tabs, messages, startup

chrome.tabs.onActivated.addListener(onTabActivated);
chrome.windows?.onFocusChanged?.addListener(onWindowFocused);
chrome.tabs.onRemoved.addListener(forgetTab);

// Browsers that report in-page navigation themselves don't need the content script's reports.
chrome.runtime.onMessage.addListener(createMessageHandler({ onInPageNavigation: historyEvents ? null : onInPageNavigation }));

async function init() {
  await checkVault().catch(log); // seals sign-ins saved before encryption
  await captureSession(undefined);
  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  init().catch(log);
  if (reason === "install") chrome.runtime.openOptionsPage().catch(log);
});
chrome.runtime.onStartup.addListener(() => init().catch(log));

// With a passphrase set, the sign-ins are locked once the browser starts: ask for it right away. Once
// per browser session, whichever event starts the background: storage.session starts out empty with
// the browser (and after an update of the extension). Without it, only at the browser's start.
async function askToUnlockOnce() {
  if (chrome.storage.session) {
    if ((await chrome.storage.session.get("unlockAsked")).unlockAsked) return;
    await chrome.storage.session.set({ unlockAsked: true });
  }
  if (await shouldAskToUnlock()) await chrome.tabs.create({ url: chrome.runtime.getURL("src/unlock/unlock.html") });
}
if (chrome.storage.session) askToUnlockOnce().catch(log);
else chrome.runtime.onStartup.addListener(() => askToUnlockOnce().catch(log));

// The browser may stop the background when idle and start it again for the next event.
trace("background started", {
  version: chrome.runtime.getManifest().version,
  webRequest: Boolean(chrome.webRequest?.onBeforeRequest),
  inPageEvents: Boolean(historyEvents),
});
