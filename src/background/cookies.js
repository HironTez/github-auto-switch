// GitHub's sign-in cookies: reading them, and putting a saved sign-in in place.

import { noteAccount } from "./history.js";
import { log } from "./log.js";

const GITHUB_URL = "https://github.com/";
// The cookies that make up a GitHub sign-in, in the order they are written when switching.
// dotcom_user names the account, so it is written last, after the session it describes.
const SESSION_COOKIES = ["logged_in", "__Host-user_session_same_site", "user_session", "dotcom_user"];
// Per-visit state GitHub sends anew with every response. It is not saved: a switch removes it, so a
// copy left over from another account can't mix with the new sign-in. GitHub starts a fresh one.
const VISIT_COOKIES = ["_gh_sess"];

const storeArg = (storeId) => (storeId ? { storeId } : {});
const cookieUrl = (c) => `https://${c.domain.replace(/^\./, "")}${c.path || "/"}`;
export const cookieKey = (c) => `${c.name}|${c.domain}|${c.path}`;
export const isGithubCookie = (c) => c.domain === "github.com" || c.domain === ".github.com";

export async function readSessionCookies(storeId) {
  const all = await chrome.cookies.getAll({ url: GITHUB_URL, ...storeArg(storeId) });
  return all.filter((c) => SESSION_COOKIES.includes(c.name) && isGithubCookie(c));
}

/** The signed-in login according to the cookies, or null when signed out. */
export function loginOf(cookies) {
  const value = (name) => cookies.find((c) => c.name === name)?.value;
  const login = value("dotcom_user");
  return login && value("user_session") && value("logged_in") !== "no" ? login : null;
}

export const readLogin = async (storeId) => loginOf(await readSessionCookies(storeId));

/** The session token, which identifies a sign-in. */
export const sessionValue = (cookies) => cookies.find((c) => c.name === "user_session")?.value;

/** The parts of a cookie worth saving. */
export function pickCookie(c) {
  const { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, session, expirationDate } = c;
  return { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, session, expirationDate };
}

function toSetDetails(c, storeId) {
  const details = {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path || "/",
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...storeArg(storeId),
  };
  if (!c.hostOnly) details.domain = c.domain;
  if (["no_restriction", "lax", "strict"].includes(c.sameSite)) details.sameSite = c.sameSite;
  if (!c.session) {
    // A saved cookie may have passed its expiry while the account was unused. GitHub decides whether
    // the session is still valid; give the cookie a day so the browser sends it, and GitHub renews it.
    const now = Date.now() / 1000;
    details.expirationDate = c.expirationDate > now + 60 ? c.expirationDate : now + 86_400;
  }
  return details;
}

const removeCookie = (c, storeId) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, ...storeArg(storeId) });

let swapping = 0;

/** Whether a switch is changing the cookies right now (their change events are the extension's own). */
export const isSwapping = () => swapping > 0;

/** Puts the saved sign-in `session` in place of whatever GitHub cookies are there. */
export async function swapTo(session, storeId) {
  swapping++;
  noteAccount(storeId, null);
  try {
    // Sign-ins saved by version 0.1.0 still include visit cookies; those are never restored.
    const cookies = session.cookies.filter((c) => SESSION_COOKIES.includes(c.name));
    const wanted = new Set(cookies.map(cookieKey));
    const before = (await chrome.cookies.getAll({ url: GITHUB_URL, ...storeArg(storeId) })).filter(
      (c) => isGithubCookie(c) && (SESSION_COOKIES.includes(c.name) || VISIT_COOKIES.includes(c.name)),
    );
    try {
      for (const c of before) {
        if (!wanted.has(cookieKey(c))) await removeCookie(c, storeId);
      }
      const ordered = [...cookies].sort((a, b) => SESSION_COOKIES.indexOf(a.name) - SESSION_COOKIES.indexOf(b.name));
      for (const c of ordered) await chrome.cookies.set(toSetDetails(c, storeId));
    } catch (error) {
      // Half a switch would mix two accounts' cookies: put the sign-in back as it was, as far as possible.
      const had = new Set(before.map(cookieKey));
      const failed = (c) => (e) => log(`switch undone, but ${c.name} not restored:`, e);
      for (const c of cookies) {
        if (!had.has(cookieKey(c))) await removeCookie(c, storeId).catch(failed(c));
      }
      for (const c of before) await chrome.cookies.set(toSetDetails(c, storeId)).catch(failed(c));
      throw error;
    }
  } finally {
    noteAccount(storeId, await readLogin(storeId).catch(() => null));
    swapping--;
  }
}

/** The cookie store a tab uses (private windows and Firefox containers have their own). */
export async function storeIdForTab(tabId) {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.find((s) => s.tabIds.includes(tabId))?.id;
  } catch {
    return undefined;
  }
}
