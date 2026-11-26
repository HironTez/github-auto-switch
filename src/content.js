// Tells the background which account this github.com page was rendered for, so it can verify a
// switch and correct a page that loaded with the wrong account.
// GitHub puts the signed-in login in <meta name="user-login"> ("" when signed out).
//
// It also reports GitHub's in-page navigation (clicking links without a page load). The background
// only uses that where the browser can't tell it directly (Safari has no
// webNavigation.onHistoryStateUpdated).
(() => {
  const withoutHash = () => location.href.split("#")[0];
  const report = (inPage) => {
    const meta = document.querySelector('meta[name="user-login"]');
    chrome.runtime
      .sendMessage({ type: "page", url: location.href, login: meta ? meta.content : null, inPage })
      .catch(() => {});
  };

  let lastUrl = withoutHash();
  const checkUrl = () => {
    if (withoutHash() === lastUrl) return;
    lastUrl = withoutHash();
    report(true);
  };

  report(false);
  // Every GitHub navigation changes the document title, which lives in <head>.
  new MutationObserver(checkUrl).observe(document.head ?? document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  document.addEventListener("turbo:load", checkUrl);
  window.addEventListener("popstate", checkUrl);
})();
