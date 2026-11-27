import { parseGithubUrl, resolveAccount } from "../lib/rules.js";
import { loadSessions, loadSettings, loadStatus, saveSettings } from "../lib/storage.js";
import { accountLabel, el, sendMessage, statusTag, watchGithubAccess } from "../ui/account.js";
import { biometricName, unlockForm } from "../ui/unlock.js";

const $ = (id) => document.getElementById(id);

let shownLocked = false;

/** The unlock form while locked. Built once per lock, so typing survives other updates. */
function renderLock(vault) {
  const locked = Boolean(vault?.locked);
  $("locked").hidden = !locked;
  if (locked === shownLocked) return;
  shownLocked = locked;
  if (!locked) return $("unlock").replaceChildren();
  // The passkey prompt would close the popup: biometrics unlock in a tab.
  const elsewhere = el("button", { class: "link", type: "button" }, `Unlock with ${biometricName()}…`);
  elsewhere.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/unlock/unlock.html") });
    window.close();
  });
  $("unlock").replaceChildren(
    unlockForm({ biometric: vault.biometric, allowBiometric: false, biometricElsewhere: el("div", {}, elsewhere) }),
  );
}

async function render() {
  const [settings, sessions, status, [tab]] = await Promise.all([
    loadSettings(),
    loadSessions(),
    loadStatus(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  $("enabled").checked = settings.enabled;
  $("problem").hidden = !status.problem;
  $("problem-text").textContent = status.problem ?? "";
  renderLock(await sendMessage({ type: "vaultStatus" }).catch(() => null));

  const current = await sendMessage({ type: "currentAccount", tabId: tab?.id }).catch(() => null);
  $("current").replaceChildren(current ? accountLabel(current) : "nobody");

  // tab.url is only visible for pages the extension has access to, which is exactly github.com.
  const page = tab?.url ? parseGithubUrl(tab.url) : null;
  let thisPage;
  if (!page) thisPage = "not a GitHub page";
  else if (page.kind === "neutral") thisPage = "sign-in or settings page: never switched";
  else {
    const decision = resolveAccount(tab.url, settings, Object.values(sessions).map((s) => s.login));
    thisPage = decision
      ? el("span", {}, accountLabel(decision.account), el("span", { class: "muted" }, ` (${decision.reason})`))
      : "keeps the current account";
  }
  $("this-page").replaceChildren(thisPage);

  const accounts = Object.values(sessions).sort((a, b) => a.login.localeCompare(b.login));
  $("accounts").replaceChildren(...accounts.map((s) => el("li", {}, accountLabel(s.login), statusTag(s))));
  $("no-accounts").hidden = accounts.length > 0;
}

$("enabled").addEventListener("change", async () => {
  const settings = await loadSettings();
  await saveSettings({ ...settings, enabled: $("enabled").checked });
});

$("problem-dismiss").addEventListener("click", () => sendMessage({ type: "clearProblem" }));

$("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener(() => render());
render();
watchGithubAccess($("access"), $("access-grant"));
