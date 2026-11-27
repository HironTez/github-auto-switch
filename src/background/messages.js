// Messages from the content script, the popup and the settings page.

import { captureSession, forgetAccount } from "./accounts.js";
import { readLogin, storeIdForTab } from "./cookies.js";
import { followFront, followIfFront } from "./front.js";
import { log, trace } from "./log.js";
import { refreshBadge, setProblem } from "./problems.js";
import { getSessions, getSettings } from "./state.js";
import { handleNavigation, handlePageReport, moment } from "./switching.js";
import * as vault from "./vault.js";

const fromTopFrame = (sender) => sender.tab?.id != null && sender.frameId === 0;
/**
 * Whether the message comes from the popup or the settings page (also when opened in a tab), not from
 * a content script, which runs in a GitHub page. Without a sender URL, only a sender outside any tab
 * counts (content scripts always have one).
 */
export const fromExtensionPage = (sender) =>
  sender.id === chrome.runtime.id && (sender.url ? sender.url.startsWith(chrome.runtime.getURL("")) : !sender.tab);
// What content scripts (in GitHub's pages) may send. Every other message is accepted from the
// extension's own pages only.
const FROM_CONTENT_SCRIPTS = new Set(["page", "rulesState", "switchForNavigation", "trace"]);

/** The switch the tab in front missed while locked happens now. */
async function afterUnlock() {
  trace("unlocked");
  await refreshBadge();
  followFront().catch(log);
}

/**
 * @param {(tabId: number, url: string) => void} onInPageNavigation where the browser can't report
 *   GitHub's in-page navigation itself, the content script's report goes here.
 */
export function createMessageHandler({ onInPageNavigation }) {
  async function handle(message, sender) {
    if (!FROM_CONTENT_SCRIPTS.has(message?.type) && !fromExtensionPage(sender)) {
      trace("message refused", { type: String(message?.type), from: sender.url ?? null });
      return null;
    }
    switch (message?.type) {
      // Content script: a page loaded (or GitHub navigated in-page) and shows `login`.
      case "page": {
        if (!fromTopFrame(sender)) return null;
        const tabId = sender.tab.id;
        if (message.inPage) {
          onInPageNavigation?.(tabId, String(message.url));
          return null;
        }
        // Remember the account the page was loaded with. This is how accounts that were signed in
        // before the extension had access to github.com (or that GitHub's account switcher selects)
        // become known: opening any GitHub page with them is enough.
        const reportedAt = moment();
        if (message.login) await captureSession(await storeIdForTab(tabId), { pageLogin: message.login }).catch(log);
        const docStart = typeof message.docStart === "number" ? message.docStart : null;
        try {
          await handlePageReport(tabId, sender.url ?? String(message.url), message.login, { docStart, reportedAt });
        } finally {
          await followIfFront(tabId).catch(log); // the report's own error, if any, is the one answered
        }
        return null;
      }
      // Content script: what it needs to tell whether a clicked link needs another account.
      case "rulesState": {
        const sessions = await getSessions();
        const accounts = Object.values(sessions).map((s) => ({ login: s.login, stale: Boolean(s.stale) }));
        return { settings: await getSettings(), accounts };
      }
      // Content script: a clicked link needs another account; it loads the page once this answers.
      case "switchForNavigation":
        if (!fromTopFrame(sender)) return null;
        trace("link clicked", { tab: sender.tab.id, url: String(message.url) });
        await handleNavigation(sender.tab.id, String(message.url), { mode: "click" });
        return null;
      case "trace":
        trace(`page: ${String(message.event)}`, { tab: sender.tab?.id, ...message.details });
        return null;
      // Popup: the account signed in now (for the tab's cookie store); also remembers it.
      case "currentAccount": {
        const storeId = message.tabId != null ? await storeIdForTab(message.tabId) : undefined;
        captureSession(storeId).catch(log);
        return readLogin(storeId);
      }
      // Settings page.
      case "removeAccount":
        await forgetAccount(message.login);
        return null;
      case "clearProblem":
        await setProblem(null);
        return null;
      // Popup, settings and unlock page: the saved sign-ins' encryption (vault.js).
      case "vaultStatus":
        return vault.vaultStatus();
      case "unlock":
        await vault.unlock({ passphrase: message.passphrase, prf: message.prf });
        await afterUnlock();
        return null;
      case "lock":
        await vault.lock();
        await refreshBadge();
        return null;
      case "setPassphrase":
        await vault.setPassphrase(message.passphrase);
        await refreshBadge();
        return null;
      case "removePassphrase":
        await vault.removePassphrase();
        await afterUnlock();
        return null;
      case "addBiometric":
        await vault.addBiometric({ credentialId: message.credentialId, prfSalt: message.prfSalt, prf: message.prf });
        return null;
      case "resetVault":
        await vault.resetVault();
        await afterUnlock();
        return null;
      case "removeBiometric":
        await vault.removeBiometric();
        return null;
      case "setAskOnStart":
        await vault.setAskOnStart(message.askOnStart);
        return null;
      default:
        return null;
    }
  }

  /** runtime.onMessage listener. Answers { result } or { error }. */
  return (message, sender, sendResponse) => {
    handle(message, sender).then(
      (result) => sendResponse({ result }),
      (error) => {
        log(`message ${message?.type}:`, error);
        sendResponse({ error: error?.message ?? String(error) });
      },
    );
    return true;
  };
}
