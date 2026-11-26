// Pure logic: which GitHub account a URL should be opened with.
// No browser APIs here, so the same module runs in the extension and in `node --test`.

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // Login used for everything no rule matches. "" = leave the current account alone.
  defaultAccount: "",
  // github.com/<login>/... of a known account opens with that account.
  ownContent: true,
  // Pages that belong to no owner (dashboard, notifications, search...): "default" or "keep".
  generalPages: "default",
  // Also react to GitHub's in-page navigation (clicking links), not only to full page loads.
  inPageNavigation: true,
  // { type: "repo" | "owner", pattern: string, account: string }
  rules: [],
  // Record what the extension sees and does (storage.local "activity"), for troubleshooting.
  activityLog: false,
});

// First path segments that are GitHub pages, not user or organization names.
// GitHub does not allow accounts with these names.
const GENERAL_ROUTES = new Set([
  "about", "apps", "blog", "codespaces", "collections", "contact", "copilot", "customer-stories",
  "dashboard", "discussions", "education", "enterprise", "enterprises", "events", "explore",
  "features", "git-guides", "github-copilot", "home", "issues", "marketplace", "mobile", "models",
  "new", "nonprofit", "notifications", "partners", "premium-support", "pricing", "pulls", "readme",
  "resources", "search", "security", "site", "solutions", "spark", "sponsors", "stars", "team",
  "topics", "trending", "watching", "why-github",
]);

// Pages where switching would break what the user is doing: signing in or out, account settings.
const NEUTRAL_ROUTES = new Set([
  "account", "auth", "join", "login", "logout", "password_reset", "session", "sessions",
  "settings", "signup", "switch_account",
]);

// /orgs/<org>/..., /organizations/<org>/... and /users/<user>/... belong to that owner.
const OWNER_PREFIXES = new Set(["orgs", "organizations", "users"]);

/**
 * Classifies a URL.
 * @returns {null | {kind: "neutral"} | {kind: "general"} | {kind: "owner", owner: string, repo: string | null}}
 *   null when it is not a github.com page.
 */
export function parseGithubUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean).map(safeDecode);
  if (segments.length === 0) return { kind: "general" };

  const first = segments[0].toLowerCase();
  if (NEUTRAL_ROUTES.has(first)) return { kind: "neutral" };
  // Internal endpoints (/_graphql, /_side-panels) and files (/favicon.ico) are never owners.
  if (first.startsWith("_") || first.includes(".")) return { kind: "neutral" };

  if (OWNER_PREFIXES.has(first)) {
    return segments[1] ? { kind: "owner", owner: segments[1], repo: null } : { kind: "general" };
  }
  if (GENERAL_ROUTES.has(first)) return { kind: "general" };

  const repo = segments[1] ? segments[1].replace(/\.git$/i, "") : null;
  return { kind: "owner", owner: segments[0], repo: repo || null };
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Case-insensitive glob match; `*` matches any run of characters except "/". */
export function globMatch(pattern, value) {
  const source = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "i").test(value);
}

export function sameLogin(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** Fills in defaults and drops malformed rules, so stored data from any version is safe to use. */
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    enabled: s.enabled !== false,
    defaultAccount: typeof s.defaultAccount === "string" ? s.defaultAccount.trim() : "",
    ownContent: s.ownContent !== false,
    generalPages: s.generalPages === "keep" ? "keep" : "default",
    inPageNavigation: s.inPageNavigation !== false,
    activityLog: s.activityLog === true,
    rules: (Array.isArray(s.rules) ? s.rules : [])
      .filter((r) => r && (r.type === "repo" || r.type === "owner"))
      .map((r) => ({
        type: r.type,
        pattern: typeof r.pattern === "string" ? r.pattern.trim() : "",
        account: typeof r.account === "string" ? r.account.trim() : "",
      })),
  };
}

/** A rule is usable when its pattern fits its type and it names an account. */
export function isRuleComplete(rule) {
  if (!rule.account || !rule.pattern) return false;
  const parts = rule.pattern.split("/");
  return rule.type === "repo" ? parts.length === 2 && parts.every(Boolean) : parts.length === 1;
}

/**
 * Decides which account a URL should be opened with.
 * Precedence: repository rules, then owner rules (each in list order), then own content, then default.
 * @param {string} url
 * @param {ReturnType<typeof normalizeSettings>} settings
 * @param {string[]} knownLogins accounts the extension has a session for
 * @returns {null | {account: string, reason: string}} null: leave the current account alone.
 */
export function resolveAccount(url, settings, knownLogins = []) {
  const page = parseGithubUrl(url);
  if (!page || page.kind === "neutral") return null;

  const rules = settings.rules.filter(isRuleComplete);

  if (page.kind === "owner") {
    if (page.repo) {
      const fullName = `${page.owner}/${page.repo}`;
      const rule = rules.find((r) => r.type === "repo" && globMatch(r.pattern, fullName));
      if (rule) return { account: rule.account, reason: `repository rule “${rule.pattern}”` };
    }
    const rule = rules.find((r) => r.type === "owner" && globMatch(r.pattern, page.owner));
    if (rule) return { account: rule.account, reason: `owner rule “${rule.pattern}”` };

    if (settings.ownContent) {
      const own = knownLogins.find((login) => sameLogin(login, page.owner));
      if (own) return { account: own, reason: "account’s own content" };
    }
  } else if (settings.generalPages === "keep") {
    return null;
  }

  return settings.defaultAccount ? { account: settings.defaultAccount, reason: "default account" } : null;
}
