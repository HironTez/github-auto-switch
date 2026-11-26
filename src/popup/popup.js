import { parseGithubUrl, resolveAccount } from "../lib/rules.js";
import { loadSessions, loadSettings, loadStatus, saveSettings } from "../lib/storage.js";
import { accountLabel, el, sendMessage, statusTag, watchGithubAccess } from "../ui/account.js";

const $ = (id) => document.getElementById(id);

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
