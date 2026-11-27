// The tab in front: when a GitHub tab comes to the front, the account its page was opened with is put
// back, without reloading. The tab is reloaded instead when, while it was in the background, its page
// loaded with the wrong account or sent requests while another account was signed in. That reload
// happens at once, also while the page's images and other parts still load; never while the tab loads
// another page, which decides for itself once it reports.

import { sameLogin } from "../lib/rules.js";
import { readLogin, storeIdForTab } from "./cookies.js";
import { requestAsOtherAccount } from "./history.js";
import { log, trace } from "./log.js";
import { getSessions, getSettings } from "./state.js";
import { isLocked } from "./vault.js";
import {
  enqueue, frontTab, handleNavigation, isFrontTab, isGithubTab, isLoadingNewPage, isPending, moment, noteLoadStart,
  restorePrevious, signInAs, startedLoadingSince, stopWaitingExcept, takeSkipped,
} from "./switching.js";

// Requests the page sent as it came to the front, before the switch back, show up once they finish:
// a tab that came to the front is checked again after this long.
const RECHECK_MS = 3000;

/**
 * Puts the account of the page in tab `tabId` in place, and reloads the page if it needs it.
 * `recheck`: check again after RECHECK_MS (when the tab has just come to the front).
 */
async function followTab(tabId, { recheck }) {
  if (isPending(tabId) || !(await getSettings()).enabled || !(await isGithubTab(tabId))) return;
  // The tab is loading another page: that page reports for itself and is followed then (followIfFront),
  // or, if its load ends without a page, when the load ends (onTabComplete).
  if (await isLoadingNewPage(tabId)) return;
  const askedAt = moment();
  // { login, url, requests }: see content.js.
  const page = await chrome.tabs.sendMessage(tabId, { type: "shownLogin" }).catch(() => null);
  if (page?.login == null) return; // not a GitHub page (or not reporting yet)

  const mark = await takeSkipped(tabId);
  if (mark?.restore && page.login === "") {
    // GitHub rejected the sign-in a switch gave this page after it had left the front.
    await restorePrevious(tabId, { previous: mark.restore, storeId: await storeIdForTab(tabId) }, askedAt);
    return;
  }
  if (mark) {
    // A { restore } mark on a page that shows an account: the tab was loaded again since; handled like {}.
    trace("background tab came to the front", { tab: tabId, url: page.url, account: page.login });
    const switched = await handleNavigation(tabId, page.url, { mode: "page", pageLogin: page.login, seenAt: askedAt });
    if (switched) return; // and reloaded
  }
  if (!page.login) return; // signed out

  const reloaded = await enqueue(async () => {
    // Again: the queue may have held this job while another switch ran or the tab started loading.
    if (isPending(tabId) || startedLoadingSince(tabId, askedAt) || !(await isFrontTab(tabId))) return false;
    const target = (await getSessions())[page.login.toLowerCase()];
    if (!target || target.stale) return false;
    const storeId = await storeIdForTab(tabId);
    const current = await readLogin(storeId);
    if (!sameLogin(current, target.login)) {
      if (await isLocked()) {
        trace("can't follow tab in front", { tab: tabId, url: page.url, account: target.login, why: "locked" });
        return true; // no recheck: unlocking follows the tab in front
      }
      await signInAs(target, storeId, current);
      trace("followed tab in front", { tab: tabId, url: page.url, from: current, to: target.login });
    }
    // While it was in the background, the page may have sent requests (updates, polling) as the account
    // signed in then. Whatever they changed on the page can't be trusted: load it again.
    const at = await requestAsOtherAccount(storeId, target.login, page.requests);
    if (at == null) return false;
    if (startedLoadingSince(tabId, askedAt)) return false; // a page the user opened meanwhile decides
    trace("page sent requests as another account; reloading", {
      tab: tabId, url: page.url, account: target.login, secondsAgo: Math.round((Date.now() - at) / 1000),
    });
    noteLoadStart(tabId);
    await chrome.tabs.reload(tabId);
    return true;
  });
  if (!reloaded && recheck) setTimeout(() => followTab(tabId, { recheck: false }).catch(log), RECHECK_MS);
}

/**
 * After a page reported: if its tab is in front, put the page's account in place. Covers a tab that
 * came to the front while its page was loading or while a switch for it was under way.
 */
export async function followIfFront(tabId) {
  if (!(await isFrontTab(tabId))) return;
  await followTab(tabId, { recheck: false });
}

/** After unlocking: the tab in front gets its account (or the switch it missed while locked). */
export async function followFront() {
  const front = await frontTab();
  if (front) await followTab(front.id, { recheck: false });
}

/** tabs.onUpdated listener for status "complete": a load ended, also one that brought no page. */
export function onTabComplete(tabId) {
  followIfFront(tabId).catch(log);
}

/** A tab came to the front: stop waiting for others' pages, and follow it. */
function cameToFront(tabId) {
  stopWaitingExcept(tabId);
  return followTab(tabId, { recheck: true });
}

/** tabs.onActivated listener. */
export function onTabActivated({ tabId }) {
  cameToFront(tabId).catch(log);
}

/** windows.onFocusChanged listener. */
export function onWindowFocused(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  frontTab()
    .then((front) => front && cameToFront(front.id))
    .catch(log);
}
