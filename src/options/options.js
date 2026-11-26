import { isRuleComplete, normalizeSettings, parseGithubUrl, resolveAccount, sameLogin } from "../lib/rules.js";
import { loadSessions, loadSettings, loadStatus, saveSettings } from "../lib/storage.js";
import { accountLabel, el, sendMessage, statusTag, watchGithubAccess } from "../ui/account.js";

const $ = (id) => document.getElementById(id);

let settings = normalizeSettings({});
let sessions = {};
let lastSaved = "";

// ---------------------------------------------------------------------------------------------------
// Saving

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  lastSaved = JSON.stringify(normalizeSettings(settings));
  saveSettings(settings).catch((error) => showProblem(`Could not save: ${error.message}`));
  renderTry();
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
  renderTry();
}

// ---------------------------------------------------------------------------------------------------
// Accounts

const byLogin = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Remembered accounts, plus names the settings mention that are not remembered (yet). */
function accountChoices() {
  const logins = Object.values(sessions).map((s) => s.login).sort(byLogin);
  for (const name of [settings.defaultAccount, ...settings.rules.map((r) => r.account)]) {
    if (name && !logins.some((l) => sameLogin(l, name))) logins.push(name);
  }
  return logins;
}

function sessionOf(login) {
  return sessions[login.toLowerCase()];
}

function accountSelect(selected, emptyLabel, onChange, label) {
  const select = el("select", { "aria-label": label });
  select.append(el("option", { value: "" }, emptyLabel));
  for (const login of accountChoices()) {
    const session = sessionOf(login);
    const note = !session ? " (not signed in)" : session.stale ? " (signed out)" : "";
    select.append(el("option", { value: login }, login + note));
  }
  select.value = accountChoices().find((l) => sameLogin(l, selected)) ?? "";
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function renderAccounts() {
  const list = $("accounts");
  const all = Object.values(sessions).sort((a, b) => byLogin(a.login, b.login));
  list.replaceChildren(
    ...all.map((session) =>
      el(
        "li",
        {},
        accountLabel(session.login),
        statusTag(session),
        el(
          "span",
          { class: "muted" },
          session.stale ? "sign in to it again on github.com" : `saved ${new Date(session.updatedAt).toLocaleDateString()}`,
        ),
        el("span", { class: "spacer" }),
        el(
          "button",
          {
            type: "button",
            title: "Forget this account’s saved sign-in. It is remembered again the next time you sign in to it.",
            onclick: () => sendMessage({ type: "removeAccount", login: session.login }),
          },
          "Forget",
        ),
      ),
    ),
  );
  $("no-accounts").hidden = all.length > 0;
}

// ---------------------------------------------------------------------------------------------------
// Rules

function ruleRow(rule) {
  const isRepo = rule.type === "repo";
  const input = el("input", {
    type: "text",
    value: rule.pattern,
    placeholder: isRepo ? "owner/repository" : "organization or user",
    spellcheck: false,
    autocomplete: "off",
    "aria-label": isRepo ? "Repository" : "Owner",
  });
  const validate = () => {
    const ok = !rule.pattern || isRuleComplete({ ...rule, account: "-" });
    input.setAttribute("aria-invalid", String(!ok));
    input.title = ok ? "" : isRepo ? "Use owner/repository" : "Use a single name, without “/”";
  };
  input.addEventListener("input", () => {
    rule.pattern = input.value.trim();
    validate();
    saveSoon();
  });
  input.addEventListener("change", save);
  validate();

  const select = accountSelect(rule.account, "Choose account", (value) => {
    rule.account = value;
    save();
  }, "Account");

  const remove = el(
    "button",
    {
      type: "button",
      title: "Remove rule",
      "aria-label": "Remove rule",
      onclick: () => {
        settings.rules.splice(settings.rules.indexOf(rule), 1);
        renderRules();
        save();
      },
    },
    "✕",
  );

  return el("div", { class: "rule" }, input, el("span", { class: "arrow", "aria-hidden": "true" }, "→"), select, remove);
}

function renderRules() {
  for (const type of ["repo", "owner"]) {
    $(`${type}-rules`).replaceChildren(...settings.rules.filter((r) => r.type === type).map(ruleRow));
  }
}

function addRule(type) {
  const rule = { type, pattern: "", account: "" };
  // Keep repository rules before owner rules in storage, matching the order they apply in.
  const index = type === "repo" ? settings.rules.filter((r) => r.type === "repo").length : settings.rules.length;
  settings.rules.splice(index, 0, rule);
  renderRules();
  $(`${type}-rules`).lastElementChild?.querySelector("input")?.focus();
}

// ---------------------------------------------------------------------------------------------------
// General options

function renderGeneral() {
  $("enabled").checked = settings.enabled;
  $("ownContent").checked = settings.ownContent;
  $("generalPages").value = settings.generalPages;
  $("inPageNavigation").checked = settings.inPageNavigation;
  $("defaultAccount").replaceWith(
    Object.assign(
      accountSelect(settings.defaultAccount, "none: keep the current account", (value) => {
        settings.defaultAccount = value;
        save();
      }, "Default account"),
      { id: "defaultAccount" },
    ),
  );
}

for (const id of ["enabled", "ownContent", "inPageNavigation"]) {
  $(id).addEventListener("change", () => {
    settings[id] = $(id).checked;
    save();
  });
}
$("generalPages").addEventListener("change", () => {
  settings.generalPages = $("generalPages").value;
  save();
});
$("add-repo").addEventListener("click", () => addRule("repo"));
$("add-owner").addEventListener("click", () => addRule("owner"));

// ---------------------------------------------------------------------------------------------------
// Try a URL

function explain(url) {
  if (!url) return "";
  const page = parseGithubUrl(url.includes("://") ? url : `https://${url}`);
  if (!page) return "Not a github.com page: nothing happens.";
  if (page.kind === "neutral") return "Sign-in and settings pages never switch accounts.";
  const fullUrl = url.includes("://") ? url : `https://${url}`;
  const decision = resolveAccount(fullUrl, settings, Object.values(sessions).map((s) => s.login));
  const off = settings.enabled ? "" : " (Switching is turned off right now.)";
  if (!decision) return `Keeps the current account.${off}`;
  const session = sessionOf(decision.account);
  const unavailable = !session
    ? ` ${decision.account} is not signed in yet, so the current account is kept.`
    : session.stale
      ? ` ${decision.account} is signed out, so the current account is kept.`
      : "";
  return `Opens as ${decision.account}, because of the ${decision.reason}.${unavailable}${off}`;
}

function renderTry() {
  $("try-result").textContent = explain($("try-url").value.trim());
}

$("try-url").addEventListener("input", renderTry);

// ---------------------------------------------------------------------------------------------------
// Problems

function showProblem(problem) {
  $("problem").hidden = !problem;
  $("problem-text").textContent = problem ?? "";
}

$("problem-dismiss").addEventListener("click", () => sendMessage({ type: "clearProblem" }));

// ---------------------------------------------------------------------------------------------------
// Loading and live updates

function renderAll() {
  renderGeneral();
  renderRules();
  renderAccounts();
  renderTry();
}

chrome.storage.onChanged.addListener(async (changes) => {
  if ("settings" in changes) {
    const fresh = await loadSettings();
    // Ignore the echo of our own save; re-render when another page (the popup) changed something.
    if (JSON.stringify(fresh) !== lastSaved) {
      settings = fresh;
      lastSaved = JSON.stringify(fresh);
      renderAll();
    }
  }
  if ("sessions" in changes) {
    sessions = await loadSessions();
    renderAll();
  }
  if ("status" in changes) showProblem((await loadStatus()).problem);
});

[settings, sessions] = await Promise.all([loadSettings(), loadSessions()]);
lastSaved = JSON.stringify(settings);
renderAll();
showProblem((await loadStatus()).problem);
await watchGithubAccess($("access"), $("access-grant"));
