// Runs as a module service worker in Chromium/Safari and as a module event page in Firefox.
// Uses the `chrome.*` namespace: every target browser supports it with promises in MV3.
//
// How switching works
// - GitHub's sign-in lives in a few cookies (SESSION_COOKIES). Whenever they change to a signed-in
//   account, the extension keeps a copy of them for that account ("session").
// - When a tab starts loading a github.com page, the rules (lib/rules.js) pick an account. If it is not
//   the signed-in one, the extension puts that account's cookies in place and restarts the load.
// - The content script reports which account the loaded page shows. If GitHub did not accept the
//   saved session, the account is marked as signed out and the previous account is restored.

import { resolveAccount, sameLogin } from "./lib/rules.js";
import { loadSessions, loadSettings, loadStatus, saveSessions } from "./lib/storage.js";

const GITHUB_URL = "https://github.com/";
const GITHUB_PAGES = ["https://github.com/*"];
// The cookies that make up a GitHub sign-in, in the order they are written when switching.
// dotcom_user names the account, so it is written last, after the session it describes.
const SESSION_COOKIES = ["_gh_sess", "logged_in", "__Host-user_session_same_site", "user_session", "dotcom_user"];
const VERIFY_WINDOW_MS = 30_000;
const RETRY_WINDOW_MS = 20_000;
const MAX_ATTEMPTS = 2;

const log = (...args) => console.error("[github-auto-switch]", ...args);

// ---------------------------------------------------------------------------------------------------
// Cached state

let settingsCache = null;
let sessionsCache = null;
const getSettings = () => (settingsCache ??= loadSettings());
const getSessions = () => (sessionsCache ??= loadSessions());

chrome.storage.onChanged.addListener((changes) => {
  if ("settings" in changes) settingsCache = null;
  if ("sessions" in changes) sessionsCache = null;
});

// The background is the only writer of "sessions"; writes run one at a time.
let sessionWrites = Promise.resolve();
function updateSessions(mutate) {
  const run = sessionWrites.then(async () => {
    const sessions = await loadSessions();
    if (mutate(sessions) === false) return;
    await saveSessions(sessions);
    sessionsCache = Promise.resolve(sessions);
  });
  sessionWrites = run.catch(log);
  return run;
}

// ---------------------------------------------------------------------------------------------------
// Cookies

const storeArg = (storeId) => (storeId ? { storeId } : {});
const isGithubCookie = (c) => c.domain === "github.com" || c.domain === ".github.com";
const cookieKey = (c) => `${c.name}|${c.domain}|${c.path}`;
const cookieUrl = (c) => `https://${c.domain.replace(/^\./, "")}${c.path || "/"}`;

async function readSessionCookies(storeId) {
  const all = await chrome.cookies.getAll({ url: GITHUB_URL, ...storeArg(storeId) });
  return all.filter((c) => SESSION_COOKIES.includes(c.name) && isGithubCookie(c));
}

/** The signed-in login according to the cookies, or null when signed out. */
function loginOf(cookies) {
  const value = (name) => cookies.find((c) => c.name === name)?.value;
  const login = value("dotcom_user");
  return login && value("user_session") && value("logged_in") !== "no" ? login : null;
}

const sessionValue = (cookies) => cookies.find((c) => c.name === "user_session")?.value;

function pickCookie(c) {
  const { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, session, expirationDate } = c;
  return { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, session, expirationDate };
}

function toSetDetails(c, storeId) {
  const details = {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path || "/",
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...storeArg(storeId),
  };
  if (!c.hostOnly) details.domain = c.domain;
  if (["no_restriction", "lax", "strict"].includes(c.sameSite)) details.sameSite = c.sameSite;
  if (!c.session) {
    // A saved cookie may have passed its expiry while the account was unused. GitHub decides whether
    // the session is still valid; give the cookie a day so the browser sends it, and GitHub renews it.
    const now = Date.now() / 1000;
    details.expirationDate = c.expirationDate > now + 60 ? c.expirationDate : now + 86_400;
  }
  return details;
}

let swapping = 0;

async function swapTo(session, storeId) {
  swapping++;
  try {
    const wanted = new Set(session.cookies.map(cookieKey));
    for (const c of await readSessionCookies(storeId)) {
      if (!wanted.has(cookieKey(c))) {
        await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, ...storeArg(storeId) });
      }
    }
    const ordered = [...session.cookies].sort(
      (a, b) => SESSION_COOKIES.indexOf(a.name) - SESSION_COOKIES.indexOf(b.name),
    );
    for (const c of ordered) await chrome.cookies.set(toSetDetails(c, storeId));
  } finally {
    swapping--;
  }
}

async function storeIdForTab(tabId) {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.find((s) => s.tabIds.includes(tabId))?.id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------
// Remembering accounts

const captureTimers = new Map();

function scheduleCapture(storeId) {
  const key = storeId ?? "";
  clearTimeout(captureTimers.get(key));
  captureTimers.set(
    key,
    setTimeout(() => {
      captureTimers.delete(key);
      captureSession(storeId).catch(log);
    }, 1000),
  );
}

async function captureSession(storeId) {
  if (swapping) return scheduleCapture(storeId);
  const cookies = await readSessionCookies(storeId);
  const login = loginOf(cookies);
  if (!login) return;
  await updateSessions((sessions) => {
    const key = login.toLowerCase();
    const previous = sessions[key];
    // Only a new session (a fresh sign-in) clears the signed-out mark; seeing the same dead
    // session again, for example right after switching to it, does not.
    const stale = Boolean(previous?.stale) && sessionValue(previous.cookies) === sessionValue(cookies);
    sessions[key] = { login, cookies: cookies.map(pickCookie), updatedAt: Date.now(), stale };
  });
}

function markStale(predicate) {
  return updateSessions((sessions) => {
    let changed = false;
    for (const session of Object.values(sessions)) {
      if (!session.stale && predicate(session)) {
        session.stale = true;
        changed = true;
      }
    }
    return changed;
  });
}

chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  if (!isGithubCookie(cookie) || (cookie.name !== "user_session" && cookie.name !== "dotcom_user")) return;
  if (!removed) {
    scheduleCapture(cookie.storeId);
  } else if (cookie.name === "user_session" && (cause === "expired_overwrite" || cause === "expired")) {
    // GitHub expires the cookie when the session ends (sign out, revoked session).
    markStale((s) => sessionValue(s.cookies) === cookie.value).catch(log);
  }
});

// ---------------------------------------------------------------------------------------------------
// Problems shown in the toolbar

async function setProblem(problem) {
  await chrome.storage.local.set({ status: { problem, at: Date.now() } });
  await showBadge(problem);
}

async function clearProblem() {
  if ((await loadStatus()).problem) await setProblem(null);
}

async function showBadge(problem) {
  await chrome.action.setBadgeText({ text: problem ? "!" : "" });
  if (problem) await chrome.action.setBadgeBackgroundColor({ color: "#d1242f" });
}

// ---------------------------------------------------------------------------------------------------
// Switching

// Switches change cookies the whole browser profile shares, so they run one at a time, and each waits
// for its tab's page to start arriving before the next one may change the cookies again.
let queue = Promise.resolve();
function enqueue(job) {
  const run = queue.then(job);
  queue = run.catch(log);
  return run;
}

const responseWaiters = new Map();

function waitForResponse(tabId, ignoreRequestId, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const waiter = { ignoreRequestId, done };
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      if (responseWaiters.get(tabId) === waiter) responseWaiters.delete(tabId);
      resolve();
    }
    responseWaiters.set(tabId, waiter);
  });
}

function onMainFrameSettled(details) {
  const waiter = responseWaiters.get(details.tabId);
  if (waiter && details.requestId !== waiter.ignoreRequestId) waiter.done();
}

// tabId -> { expected, previous, at }: switches whose page has not reported back yet.
const pending = new Map();
// tabId -> { key, count, at }: stops endless reloading when a switch does not stick.
const attempts = new Map();

function allowAttempt(tabId, key) {
  const now = Date.now();
  const last = attempts.get(tabId);
  if (last && last.key === key && now - last.at < RETRY_WINDOW_MS) {
    if (last.count >= MAX_ATTEMPTS) return false;
    last.count++;
    return true;
  }
  attempts.set(tabId, { key, count: 1, at: now });
  return true;
}

const withoutHash = (url) => url.split("#")[0];

/**
 * Makes sure the tab shows `url` with the account the rules choose.
 * mode "request": a page load is starting; restart it after switching.
 * mode "history": GitHub navigated in-page; reload after switching.
 * mode "page":    a page finished loading and showed `pageLogin`; reload if it is the wrong one.
 */
async function handleNavigation(tabId, url, { mode, requestId, pageLogin }) {
  const settings = await getSettings();
  if (!settings.enabled) return;
  const sessions = await getSessions();
  const decision = resolveAccount(url, settings, Object.values(sessions).map((s) => s.login));
  if (!decision) return;
  const known = sessions[decision.account.toLowerCase()];
  if (!known || known.stale) return;

  await enqueue(async () => {
    // Read everything again: earlier switches in the queue may have changed it.
    const target = (await getSessions())[decision.account.toLowerCase()];
    if (!target || target.stale) return;
    const storeId = await storeIdForTab(tabId);
    const current = loginOf(await readSessionCookies(storeId));
    const shown = mode === "page" && pageLogin != null ? pageLogin : current;
    if (sameLogin(shown, target.login)) return;

    if (!allowAttempt(tabId, `${target.login} ${withoutHash(url)}`)) {
      await setProblem(`Switching to ${target.login} for ${withoutHash(url)} did not work twice in a row, so the extension stopped retrying.`);
      return;
    }
    if (!sameLogin(current, target.login)) {
      // Save the signed-in account first: right after signing in, GitHub redirects to a page the
      // rules may give to another account, before the debounced capture has run.
      if (current) await captureSession(storeId);
      await swapTo(target, storeId);
    }
    pending.set(tabId, { expected: target.login, previous: current, storeId, at: Date.now() });

    const responded = waitForResponse(tabId, requestId);
    if (mode === "request") await chrome.tabs.update(tabId, { url });
    else await chrome.tabs.reload(tabId);
    await responded;
  });
}

async function handlePageReport(tabId, url, pageLogin) {
  const switched = pending.get(tabId);
  pending.delete(tabId);

  if (switched && Date.now() - switched.at < VERIFY_WINDOW_MS && pageLogin != null) {
    if (sameLogin(pageLogin, switched.expected)) {
      await clearProblem();
      return;
    }
    if (pageLogin === "") {
      // The saved session was rejected: GitHub shows the page signed out.
      await markStale((s) => sameLogin(s.login, switched.expected));
      await setProblem(`GitHub no longer accepts the saved sign-in of ${switched.expected}. Sign in to ${switched.expected} on github.com again.`);
      await restorePrevious(tabId, switched);
      return;
    }
  }
  await handleNavigation(tabId, url, { mode: "page", pageLogin });
}

async function restorePrevious(tabId, switched) {
  if (!switched.previous) return;
  await enqueue(async () => {
    const previous = (await getSessions())[switched.previous.toLowerCase()];
    if (!previous || previous.stale) return;
    await swapTo(previous, switched.storeId);
    const responded = waitForResponse(tabId);
    await chrome.tabs.reload(tabId);
    await responded;
  });
}

// Browser differences handled below:
// - Safari before 18.4 has no webRequest for Manifest V3 extensions. Without it, the page check
//   (handlePageReport) still corrects a page that loaded with the wrong account, with one reload.
// - Safari documents no `types` filter; listeners then also check details.type themselves.
// - Safari has no webNavigation.onHistoryStateUpdated; the content script reports in-page
//   navigation instead.

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
  handleNavigation(details.tabId, details.url, { mode: "request", requestId: details.requestId }).catch(log);
});
if (chrome.webRequest?.onResponseStarted) {
  onMainFrame(chrome.webRequest.onResponseStarted, onMainFrameSettled);
  onMainFrame(chrome.webRequest.onErrorOccurred, onMainFrameSettled);
} else {
  // Without webRequest, a switched tab counts as served once it has loaded.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete") responseWaiters.get(tabId)?.done();
  });
}

function handleInPageNavigation(tabId, url) {
  getSettings()
    .then((s) => s.inPageNavigation && handleNavigation(tabId, url, { mode: "history" }))
    .catch(log);
}

const historyEvents = chrome.webNavigation?.onHistoryStateUpdated;
historyEvents?.addListener(
  (details) => {
    if (details.frameId === 0) handleInPageNavigation(details.tabId, details.url);
  },
  { url: [{ schemes: ["https"], hostEquals: "github.com" }] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
  attempts.delete(tabId);
});

// ---------------------------------------------------------------------------------------------------
// Messages from the content script, popup and options page

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "page":
      if (sender.tab?.id == null || sender.frameId !== 0) return null;
      if (!message.inPage) await handlePageReport(sender.tab.id, sender.url ?? message.url, message.login);
      // Browsers with webNavigation report in-page navigation themselves.
      else if (!historyEvents) handleInPageNavigation(sender.tab.id, message.url);
      return null;
    case "currentAccount": {
      const storeId = message.tabId != null ? await storeIdForTab(message.tabId) : undefined;
      return loginOf(await readSessionCookies(storeId));
    }
    case "removeAccount":
      await updateSessions((sessions) => {
        delete sessions[String(message.login).toLowerCase()];
      });
      return null;
    case "clearProblem":
      await setProblem(null);
      return null;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(
    (result) => sendResponse({ result }),
    (error) => sendResponse({ error: String(error) }),
  );
  return true;
});

// ---------------------------------------------------------------------------------------------------
// Startup

async function init() {
  await captureSession(undefined);
  await showBadge((await loadStatus()).problem);
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  init().catch(log);
  if (reason === "install") chrome.runtime.openOptionsPage().catch(log);
});
chrome.runtime.onStartup.addListener(() => init().catch(log));
