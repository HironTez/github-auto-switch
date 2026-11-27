import { isRuleComplete, normalizeSettings, parseGithubUrl, resolveAccount, sameLogin } from "../lib/rules.js";
import { loadSessions, loadSettings, loadStatus, saveSettings } from "../lib/storage.js";
import { accountLabel, el, sendMessage, statusTag, watchGithubAccess } from "../ui/account.js";
import {
  biometricName, biometricsAvailable, createPasskey, errorLine, newPassphraseForm, showError, unlockForm,
} from "../ui/unlock.js";

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
  $("activityLog").checked = settings.activityLog;
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

for (const id of ["enabled", "ownContent", "inPageNavigation", "activityLog"]) {
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
// Activity log

let activityText = "";

function formatEntry({ at, event, ...details }) {
  const time = new Date(at).toLocaleTimeString(undefined, { hour12: false }) + `.${String(at % 1000).padStart(3, "0")}`;
  const first = ["tab", "url", "account"];
  const rank = (key) => (first.includes(key) ? first.indexOf(key) : first.length);
  const fields = Object.entries(details)
    .sort(([a], [b]) => rank(a) - rank(b))
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return [time, event, ...fields].join("  ");
}

async function renderActivity() {
  const { activity } = await chrome.storage.local.get("activity");
  const entries = Array.isArray(activity) ? activity : [];
  activityText = entries.map(formatEntry).join("\n");
  const view = $("activity");
  const atEnd = view.scrollTop + view.clientHeight >= view.scrollHeight - 4;
  view.textContent = activityText || "Nothing recorded yet. Open some GitHub pages.";
  view.hidden = !settings.activityLog && !entries.length;
  if (atEnd) view.scrollTop = view.scrollHeight;
}

$("activity-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(activityText).catch(() => {});
  $("activity-copy").textContent = "Copied";
  setTimeout(() => ($("activity-copy").textContent = "Copy"), 1500);
});
$("activity-clear").addEventListener("click", () => chrome.storage.local.remove("activity"));

// ---------------------------------------------------------------------------------------------------
// Security: the saved sign-ins' encryption (background/vault.js)

let shownVault = "";

async function renderSecurity({ force = false } = {}) {
  const status = await sendMessage({ type: "vaultStatus" }).catch((error) => ({ error }));
  const json = JSON.stringify(status);
  if (!force && json === shownVault) return; // keeps what is typed in its fields
  shownVault = json;
  const box = $("security");
  const p = (...children) => el("p", { class: "muted" }, ...children);
  const refresh = () => renderSecurity({ force: true });
  if (status.error) return box.replaceChildren(el("p", { class: "error" }, String(status.error.message)));

  if (status.mode === "device") {
    box.replaceChildren(
      p(
        "Saved sign-ins are encrypted with a key that only this extension, in this browser profile, can use. ",
        "A passphrase also locks them whenever the browser starts: nothing switches until you unlock.",
      ),
      status.keyWithSignIns
        ? el("p", { class: "error" }, "This browser gives the extension no key storage (for example, it never remembers history), so the key is kept with the sign-ins. Set a passphrase to protect them.")
        : null,
      el("h3", {}, "Lock with a passphrase"),
      newPassphraseForm("Set passphrase", async (passphrase) => {
        await sendMessage({ type: "setPassphrase", passphrase });
        await refresh();
      }),
    );
    return;
  }

  if (status.locked) {
    box.replaceChildren(
      p("Locked with your passphrase. Unlock to switch accounts or to change these settings."),
      unlockForm({ biometric: status.biometric, onUnlocked: refresh }),
      el("p", {}, el("button", {
        type: "button",
        class: "link",
        onclick: async () => {
          if (!confirm("Forget every saved sign-in, the passphrase and the passkey, and start over? Your accounts come back as you open GitHub with each of them.")) return;
          await sendMessage({ type: "resetVault" }).catch((error) => alert(error.message));
          await refresh();
        },
      }, "Forgot the passphrase?")),
    );
    return;
  }

  const error = errorLine();
  const run = (job) => async () => {
    try {
      await job();
      showError(error, null);
      await refresh();
    } catch (e) {
      showError(error, e);
    }
  };
  const button = (label, job) => el("button", { type: "button", onclick: run(job) }, label);

  const askOnStart = el("input", { type: "checkbox", checked: status.askOnStart });
  askOnStart.addEventListener("change", run(() => sendMessage({ type: "setAskOnStart", askOnStart: askOnStart.checked })));

  const name = biometricName();
  let biometric;
  if (status.biometric) {
    biometric = el("div", { class: "row" }, el("span", {}, `${name} unlocks too.`), button(`Remove ${name}`, () => sendMessage({ type: "removeBiometric" })));
  } else if (await biometricsAvailable()) {
    biometric = el("div", { class: "row" }, button(`Also unlock with ${name}`, async () => {
      await sendMessage({ type: "addBiometric", ...(await createPasskey()) });
    }));
  } else {
    biometric = p(`Unlocking with ${name} is not available in this browser.`);
  }

  box.replaceChildren(
    p("Saved sign-ins are locked with your passphrase whenever the browser starts. Unlocked now."),
    el("label", { class: "toggle" }, askOnStart, "Ask to unlock when the browser starts"),
    biometric,
    el("div", { class: "row" },
      button("Lock now", () => sendMessage({ type: "lock" })),
      button("Remove passphrase", async () => {
        if (!confirm("Remove the passphrase? The sign-ins stay encrypted with a key kept in this browser, and are no longer locked at start.")) return;
        await sendMessage({ type: "removePassphrase" });
      }),
    ),
    error,
    el("h3", {}, "Change passphrase"),
    newPassphraseForm("Change passphrase", async (passphrase) => {
      await sendMessage({ type: "setPassphrase", passphrase });
      await refresh();
    }),
  );
}

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
  renderActivity();
  renderRules();
  renderAccounts();
  renderTry();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if ("vault" in changes || (area === "session" && "vaultKey" in changes)) renderSecurity();
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
  if ("activity" in changes) renderActivity();
});

[settings, sessions] = await Promise.all([loadSettings(), loadSessions()]);
lastSaved = JSON.stringify(settings);
renderAll();
showProblem((await loadStatus()).problem);
renderSecurity();
await watchGithubAccess($("access"), $("access-grant"));
