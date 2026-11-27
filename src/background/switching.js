// Switching: puts the account the rules choose in place for the page a tab loads, and checks the page
// that arrives.
//
// GitHub's cookies are shared by every tab of a browser profile, so:
// - switches run one at a time (enqueue), and each waits until its tab's page has started to arrive
//   before the next one may change the cookies again;
// - only the tab in front switches. A page in a background tab that needs another account is noted
//   (skipped tabs) and switched when its tab comes to the front (front.js).

import { resolveAccount, sameLogin } from "../lib/rules.js";
import { captureSession, markStale } from "./accounts.js";
import { readLogin, storeIdForTab, swapTo } from "./cookies.js";
import { log, trace } from "./log.js";
import { clearProblem, setProblem } from "./problems.js";
import { sessionStore } from "./session-store.js";
import { getSessions, getSettings } from "./state.js";
import { isLocked, openSignIn } from "./vault.js";

// A page that reports this long after its switch is not checked against it any more.
const VERIFY_WINDOW_MS = 30_000;
// At most MAX_ATTEMPTS switches for the same tab, account and page within RETRY_WINDOW_MS.
const RETRY_WINDOW_MS = 20_000;
const MAX_ATTEMPTS = 3;
// The longest a switch holds the next one while waiting for its page.
const RESPONSE_TIMEOUT_MS = 10_000;

const withoutHash = (url) => url.split("#")[0];

// ---------------------------------------------------------------------------------------------------
// One switch at a time

let queue = Promise.resolve();

export function enqueue(job) {
  const run = queue.then(job);
  queue = run.catch(log);
  return run;
}

// tabId -> { ignoreRequestId, done }: a switch waiting for its tab's page to start arriving.
const responseWaiters = new Map();
// tabId -> requestId of its last main-frame request whose response started to arrive or that failed.
const settledRequests = new Map();

function waitForResponse(tabId, ignoreRequestId) {
  return new Promise((resolve) => {
    const waiter = { ignoreRequestId, done };
    const timer = setTimeout(done, RESPONSE_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      if (responseWaiters.get(tabId) === waiter) responseWaiters.delete(tabId);
      resolve();
    }
    responseWaiters.set(tabId, waiter);
  });
}

/** webRequest onResponseStarted / onErrorOccurred listener for main frames. */
export function onMainFrameSettled(details) {
  settledRequests.set(details.tabId, details.requestId);
  const waiter = responseWaiters.get(details.tabId);
  if (waiter && details.requestId !== waiter.ignoreRequestId) waiter.done();
}

/** Without webRequest: a switched tab counts as served once it has loaded. */
export function onTabLoaded(tabId) {
  responseWaiters.get(tabId)?.done();
}

/**
 * Another tab came to the front: stop holding later switches for a page that a switch is loading in
 * another tab. That page is checked when it reports (and, in the background, left as it loads).
 */
export function stopWaitingExcept(tabId) {
  for (const [id, waiter] of responseWaiters) {
    if (id === tabId) continue;
    trace("tab left the front while its switched page loaded", { tab: id, front: tabId });
    waiter.done();
  }
}

// ---------------------------------------------------------------------------------------------------
// What the extension knows about each tab

// tabId -> { expected, previous, storeId, at }: switches whose page has not reported back yet.
const pending = new Map();
// tabId -> { key, count, at }: stops endless reloading when a switch does not stick.
const attempts = new Map();
// When things happened to a tab, as moments: a counter rather than a clock, so that two events in the
// same millisecond still have an order.
let moments = 0;
/** The current moment (see loadStarts). */
export const moment = () => ++moments;
// tabId -> the moment the tab last started loading a page. A report from before that is about a page
// the tab has already left.
const loadStarts = new Map();
// tabId -> the moment its page last reported.
const reports = new Map();
// Tabs that need something done when they come to the front: tabId -> mark, kept across restarts of
// the background (the browser may stop it before such a tab comes to the front). Marks:
// - {}: the tab's page needed another account while it was in the background;
// - { restore: login }: GitHub rejected the sign-in a switch gave the tab after it had left the front,
//   and `login` was signed in before. Only acted on while the page still shows signed out; otherwise
//   it counts as {}.
const skippedTabs = sessionStore("skippedTabs", {
  load: (stored) => new Map((Array.isArray(stored) ? stored : []).filter(Array.isArray)),
  save: (tabs) => [...tabs],
});

/** Sets the tab's mark (null: removes it). Resolves to the mark it had, if known. */
function setSkipped(tabId, mark) {
  return skippedTabs.update((tabs) => {
    const had = tabs.get(tabId);
    if (mark) tabs.set(tabId, mark);
    else tabs.delete(tabId);
    return had;
  });
}

export const noteLoadStart = (tabId) => loadStarts.set(tabId, moment());

/**
 * tabs.onUpdated with status "loading": a tab leaving GitHub (or loading any page outside it) starts
 * a load too, which a switch must not reload over. GitHub's own loads are noted by the GitHub-only
 * webRequest and webNavigation listeners; their in-page navigation must not count. `tab.url` is only
 * known for github.com tabs.
 */
export function onTabLoading(tabId, tab) {
  if (!tab?.url?.startsWith("https://github.com/")) noteLoadStart(tabId);
}
export const isPending = (tabId) => pending.has(tabId);
/**
 * The tab's mark from its time in the background ({ restore? }), or undefined; removes it. When the
 * marks can't be read, the mark stays for the next time.
 */
export async function takeSkipped(tabId) {
  if (!(await skippedTabs.get())) return undefined;
  return setSkipped(tabId, null);
}

/**
 * Whether the tab is loading a page that hasn't reported yet. What its current page says is then
 * about a page on its way out; the new one reports for itself. A page that has reported counts as
 * loaded, even while its images and other parts still load.
 */
export async function isLoadingNewPage(tabId) {
  const started = loadStarts.get(tabId);
  const reported = reports.get(tabId);
  // Both known and in order: the page loading now has reported. (After a restart of the background
  // neither is known; then any load counts as a new page.)
  if (reported != null && (started ?? 0) <= reported) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab?.status === "loading"; // otherwise that load ended without a page (cancelled, a download)
}

/** Whether the tab started loading a page after moment `at`. Checked right before reloading it. */
export const startedLoadingSince = (tabId, at) => (loadStarts.get(tabId) ?? 0) > at;

/** tabs.onRemoved listener. */
export function forgetTab(tabId) {
  pending.delete(tabId);
  attempts.delete(tabId);
  loadStarts.delete(tabId);
  reports.delete(tabId);
  settledRequests.delete(tabId);
  responseWaiters.get(tabId)?.done();
  setSkipped(tabId, null).catch(log);
}

/**
 * The tab in front: the active tab of the last focused window. Undefined when there is none the
 * extension can see: Safari lists only tabs of sites the extension may access, so a tab in front on
 * another site is missing.
 */
export async function frontTab() {
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return front;
}

/** Whether `tabId` is the tab in front. When that can't be told (an error), every tab counts as in front. */
export async function isFrontTab(tabId) {
  try {
    return (await frontTab())?.id === tabId;
  } catch {
    return true;
  }
}

/**
 * Whether the tab shows a github.com page. Its URL is visible only for sites the extension may
 * access, which is github.com alone; other tabs are left alone (Safari asks the user for access to
 * any site the extension reaches for).
 */
export async function isGithubTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return typeof tab?.url === "string" && tab.url.startsWith("https://github.com/");
}

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

// ---------------------------------------------------------------------------------------------------
// Switching

/**
 * Makes sure the tab shows `url` with the account the rules choose.
 * mode "request": a page load is starting; restart it after switching.
 * mode "history": GitHub navigated in-page; reload after switching.
 * mode "page":    a loaded page showed `pageLogin` (seen at moment `seenAt`); reload if it is the wrong one.
 * mode "click":   the content script is about to load `url` in the tab; only switch.
 * Only the tab in front switches (clicks come from it).
 * @returns {Promise<boolean>} whether it switched.
 */
export async function handleNavigation(tabId, url, { mode, requestId, pageLogin, seenAt }) {
  const settings = await getSettings();
  if (!settings.enabled) return false;
  const sessions = await getSessions();
  const decision = resolveAccount(url, settings, Object.values(sessions).map((s) => s.login));
  if (!decision) return false;
  const known = sessions[decision.account.toLowerCase()];
  if (!known || known.stale) {
    trace("can't switch", { tab: tabId, mode, url, wants: decision.account, why: known ? "signed out" : "not saved" });
    return false;
  }

  return enqueue(async () => {
    if (mode === "request" && settledRequests.get(tabId) === requestId) {
      // Its response has arrived (or it failed) while earlier switches ran: switching can't change
      // what it was sent as any more. The page decides when it reports. (Its response may also have
      // changed the cookies: a rejected sign-in expires them.)
      trace("load already answered", { tab: tabId, url });
      return false;
    }
    if (mode === "page" && startedLoadingSince(tabId, seenAt)) {
      // For example the page that a switch restarted: it reported before the restart, and the page that
      // replaces it reports for itself.
      trace("outdated page report ignored", { tab: tabId, url, account: pageLogin });
      return false;
    }
    // Read everything again: earlier switches in the queue may have changed it.
    const target = (await getSessions())[decision.account.toLowerCase()];
    if (!target || target.stale) return false;
    const storeId = await storeIdForTab(tabId);
    const current = await readLogin(storeId);
    const shown = mode === "page" && pageLogin != null ? pageLogin : current;
    if (sameLogin(shown, target.login)) {
      await setSkipped(tabId, null);
      if (mode !== "request") trace("right account", { tab: tabId, mode, url, account: target.login });
      return false;
    }
    if (mode !== "click" && !(await isFrontTab(tabId))) {
      // Switching now would sign out the tab in front. Check this one again when it comes to the front.
      await setSkipped(tabId, {});
      trace("background tab, not switched", { tab: tabId, mode, url, account: shown, wants: target.login });
      return false;
    }
    if (await isLocked()) {
      // Checked again once unlocked, as the tab in front (front.js).
      await setSkipped(tabId, mode === "click" ? null : {});
      trace("can't switch", { tab: tabId, mode, url, wants: target.login, why: "locked" });
      return false;
    }
    await setSkipped(tabId, null);

    if (!allowAttempt(tabId, `${target.login} ${withoutHash(url)}`)) {
      await setProblem(
        `Switching to ${target.login} for ${withoutHash(url)} did not work after ${MAX_ATTEMPTS} tries, so the extension stopped retrying.`,
      );
      return false;
    }
    // Put the saved sign-in in place even when the cookies already name the account: the page then
    // showed another one, so they are out of step (for example, a response that was on its way during
    // the last switch arrived after it and set its own cookies).
    const started = Date.now();
    await signInAs(target, storeId, current);
    pending.set(tabId, { expected: target.login, previous: current, storeId, at: Date.now() });
    trace("switched", {
      tab: tabId, mode, url, from: current, to: target.login, ...(mode === "page" ? { pageShowed: pageLogin } : {}),
      because: decision.reason, ms: Date.now() - started,
      then: { request: "restart load", click: "content script loads it" }[mode] ?? "reload",
    });
    if (mode === "click") return true;

    const loaded = mode === "request"
      ? await loadAgain(tabId, { url, ignoreRequestId: requestId })
      : await loadAgain(tabId, { since: seenAt });
    // Not reloaded: the page the user opened meanwhile is checked as any other when it reports.
    if (!loaded) pending.delete(tabId);
    return true;
  });
}

/**
 * Puts `target`'s saved sign-in in place. `current`, the account signed in now, is saved first when
 * it is another one: it may be a sign-in not saved yet (right after signing in, GitHub redirects to a
 * page the rules may give to another account, before the debounced capture has run). In the queue.
 * Throws LockedError (vault.js), before changing anything, when locked.
 */
export async function signInAs(target, storeId, current) {
  const cookies = await openSignIn(target);
  if (current && !sameLogin(current, target.login)) await captureSession(storeId);
  await swapTo({ ...target, cookies }, storeId);
}

/**
 * Loads `url` in the tab (or reloads it) and waits until the page starts to arrive. `since`: skipped
 * when the tab has started loading another page after that moment (one the user opened meanwhile).
 * Resolves to whether it loaded. In the queue.
 */
async function loadAgain(tabId, { url, ignoreRequestId, since } = {}) {
  if (since != null && startedLoadingSince(tabId, since)) {
    trace("not reloaded: another page loads", { tab: tabId });
    return false;
  }
  const responded = waitForResponse(tabId, ignoreRequestId);
  noteLoadStart(tabId);
  if (url) await chrome.tabs.update(tabId, { url });
  else await chrome.tabs.reload(tabId);
  await responded;
  return true;
}

/**
 * The content script reported the account a loaded page shows (`pageLogin`, "" when signed out).
 * `docStart`: when that page started loading (performance.timeOrigin, ms). `reportedAt`: the moment
 * the report arrived.
 */
export async function handlePageReport(tabId, url, pageLogin, { docStart, reportedAt }) {
  reports.set(tabId, reportedAt);
  const switched = pending.get(tabId);
  if (switched && docStart != null && docStart < switched.at) {
    // The page that was loading when the extension switched; the page the switch loads verifies it.
    trace("page from before the switch", { tab: tabId, url, account: pageLogin, expected: switched.expected });
    return;
  }
  pending.delete(tabId);
  // The page's response has arrived (where webRequest can't tell, the wait would last until it loaded).
  responseWaiters.get(tabId)?.done();
  trace("page shows", {
    tab: tabId, url, account: pageLogin,
    ...(switched ? { expected: switched.expected, msAfterSwitch: Date.now() - switched.at } : {}),
  });

  if (switched && Date.now() - switched.at < VERIFY_WINDOW_MS && pageLogin != null) {
    if (sameLogin(pageLogin, switched.expected)) {
      await clearProblem();
      return;
    }
    if (pageLogin === "") {
      // The saved session was rejected: GitHub shows the page signed out.
      trace("saved sign-in rejected", { tab: tabId, account: switched.expected, restoring: switched.previous });
      await markStale((s) => sameLogin(s.login, switched.expected)).catch(log);
      await setProblem(
        `GitHub no longer accepts the saved sign-in of ${switched.expected}. Sign in to ${switched.expected} on github.com again.`,
      ).catch(log);
      await restorePrevious(tabId, switched, reportedAt);
      return;
    }
  }
  await handleNavigation(tabId, url, { mode: "page", pageLogin, seenAt: reportedAt });
}

/**
 * After a rejected sign-in: puts `previous`, the account signed in before the switch, back in place and
 * reloads the tab. A tab no longer in front gets it when it returns (front.js). `seenAt`: the moment
 * the signed-out page was seen; if the tab has started loading another page since, that page decides.
 */
export async function restorePrevious(tabId, { previous: login, storeId }, seenAt) {
  if (!login) return;
  await enqueue(async () => {
    const previous = (await getSessions())[login.toLowerCase()];
    if (!previous || previous.stale || startedLoadingSince(tabId, seenAt)) return;
    if (await isLocked()) {
      // Restored once unlocked, if the tab still shows signed out then (front.js).
      await setSkipped(tabId, { restore: previous.login });
      trace("can't restore account", { tab: tabId, account: previous.login, why: "locked" });
      return;
    }
    if (!(await isFrontTab(tabId))) {
      // Another tab is in front now and has its own account.
      await setSkipped(tabId, { restore: previous.login });
      trace("background tab, account restored on return", { tab: tabId, account: previous.login });
      return;
    }
    trace("restoring account", { tab: tabId, account: previous.login });
    await signInAs(previous, storeId, await readLogin(storeId));
    await loadAgain(tabId, { since: seenAt });
  });
}
