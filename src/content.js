// Runs in every github.com page from the start of loading.
//
// - Tells the background which account the page was rendered for, as soon as GitHub's
//   <meta name="user-login"> ("" when signed out) has arrived, so a page that loaded with the wrong
//   account is corrected without waiting for the rest of it.
// - Answers which account the page shows, and when the page sent requests, so the background can put
//   that account back when the user returns to this tab, and reload it if it sent requests as another.
// - Switches before navigating when a clicked link needs another account, so that page never loads
//   with the wrong one.
// - Reports GitHub's in-page navigation. The background only uses that where the browser can't tell
//   it directly (Safari has no webNavigation.onHistoryStateUpdated).
(() => {
  const withoutHash = (url) => url.split("#")[0];
  const shownLogin = () => document.querySelector('meta[name="user-login"]')?.content ?? null;
  const send = (message) => chrome.runtime.sendMessage(message);
  // When this page started loading, so the background can tell reports of replaced pages apart.
  const docStart = Math.round(performance.timeOrigin);
  const report = (inPage) =>
    send({ type: "page", url: location.href, login: shownLogin(), inPage, docStart }).catch(() => {});

  // When this page's own requests to github.com started (ms since 1970), oldest first. The background
  // compares them with when the signed-in account changed, to tell whether the page sent requests as
  // another account while it was in the background.
  const requestTimes = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.startsWith(`${location.origin}/`)) requestTimes.push(Math.round(performance.timeOrigin + entry.startTime));
      }
      if (requestTimes.length > 300) requestTimes.splice(0, requestTimes.length - 300);
    }).observe({ type: "resource", buffered: true });
  } catch {
    // No resource timing: the background can't check this page's requests.
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "shownLogin") {
      sendResponse({ login: shownLogin(), url: location.href, requests: requestTimes.slice().sort((a, b) => a - b) });
    }
  });

  // ---------------------------------------------------------------------------------------------------
  // Page loaded, in-page navigation

  let lastUrl = withoutHash(location.href);
  const checkUrl = () => {
    if (withoutHash(location.href) === lastUrl) return;
    lastUrl = withoutHash(location.href);
    report(true);
  };

  let started = false;
  function start() {
    if (started) return;
    started = true;
    report(false);
    // Every GitHub navigation changes the document title, which lives in <head>.
    new MutationObserver(checkUrl).observe(document.head ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.addEventListener("turbo:load", checkUrl);
    window.addEventListener("popstate", checkUrl);
  }

  if (shownLogin() !== null) {
    start();
  } else {
    const waiting = new MutationObserver(() => {
      if (shownLogin() === null) return;
      waiting.disconnect();
      start();
    });
    waiting.observe(document.documentElement ?? document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => {
      waiting.disconnect();
      start();
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // Link clicks that need another account

  let rules = null; // lib/rules.js
  let state = null; // { settings, accounts: [{ login, stale }] } from the background
  const trace = (event, details) => send({ type: "trace", event, details }).catch(() => {});
  import(chrome.runtime.getURL("src/lib/rules.js")).then(
    (module) => (rules = module),
    (error) => trace("rule code did not load; clicks are not switched before loading", { error: String(error) }),
  );
  const loadState = () =>
    send({ type: "rulesState" }).then(
      (response) => (state = response?.result ?? null),
      () => {},
    );
  loadState();
  chrome.storage.onChanged.addListener(loadState);

  function accountFor(url) {
    if (!rules || !state?.settings.enabled || !state.settings.inPageNavigation) return null;
    const decision = rules.resolveAccount(url, state.settings, state.accounts.map((a) => a.login));
    if (!decision) return null;
    const account = state.accounts.find((a) => rules.sameLogin(a.login, decision.account));
    return account && !account.stale ? account.login : null;
  }

  window.addEventListener(
    "click",
    (event) => {
      // Only plain clicks that navigate this tab; new tabs and windows are switched as they load.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      let url;
      try {
        url = new URL(link.getAttribute("href"), location.href);
      } catch {
        return;
      }
      if (url.origin !== location.origin || withoutHash(url.href) === withoutHash(location.href)) return;
      if (!rules || !state) trace("link clicked before the rules were ready", { url: url.href, rules: !!rules, state: !!state });

      const account = accountFor(url.href);
      if (!account || rules.sameLogin(shownLogin(), account)) return;
      // Stop GitHub's own in-page navigation: switch first, then load the page as that account.
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: "switchForNavigation", url: url.href })
        .catch(() => {})
        .finally(() => location.assign(url.href));
    },
    true,
  );
})();
