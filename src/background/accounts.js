// Remembering accounts: a copy of each account's sign-in cookies, saved whenever that account is
// signed in, and marked as signed out when GitHub ends the session.

import { sameLogin } from "../lib/rules.js";
import { cookieKey, isGithubCookie, isSwapping, loginOf, pickCookie, readSessionCookies, sessionValue } from "./cookies.js";
import { noteAccount, storeKey } from "./history.js";
import { log, trace } from "./log.js";
import { updateSessions } from "./state.js";

const CAPTURE_DELAY_MS = 1000;
const captureTimers = new Map();

/** Saves the signed-in account soon, once a burst of cookie changes has settled. */
function scheduleCapture(storeId) {
  const key = storeKey(storeId);
  clearTimeout(captureTimers.get(key));
  captureTimers.set(
    key,
    setTimeout(() => {
      captureTimers.delete(key);
      captureSession(storeId).catch(log);
    }, CAPTURE_DELAY_MS),
  );
}

/**
 * Saves the signed-in account's cookies. `pageLogin`: the account a page was just served as; the
 * cookies are only saved if they name the same account.
 */
export async function captureSession(storeId, { pageLogin } = {}) {
  if (isSwapping()) return scheduleCapture(storeId);
  const cookies = await readSessionCookies(storeId);
  const login = loginOf(cookies);
  if (!login || (pageLogin !== undefined && !sameLogin(pageLogin, login))) return;
  await updateSessions((sessions) => {
    const key = login.toLowerCase();
    const previous = sessions[key];
    // Cookies out of step, e.g. another account's session that a response set after a switch, while
    // dotcom_user still names this account: never save them as this account's sign-in.
    const token = sessionValue(cookies);
    if (Object.entries(sessions).some(([other, s]) => other !== key && sessionValue(s.cookies) === token)) {
      return false;
    }
    const saved = new Map(previous?.cookies.map((c) => [cookieKey(c), c.value]));
    if (previous && cookies.length === saved.size && cookies.every((c) => saved.get(cookieKey(c)) === c.value)) {
      return false; // already saved as is
    }
    // Only a new session (a fresh sign-in) clears the signed-out mark; seeing the same dead
    // session again, for example right after switching to it, does not.
    const stale = Boolean(previous?.stale) && sessionValue(previous.cookies) === token;
    sessions[key] = { login, cookies: cookies.map(pickCookie), updatedAt: Date.now(), stale };
    trace("sign-in saved", { account: login, ...(previous ? {} : { new: true }) });
  });
}

/** Marks the saved sign-ins that match `predicate` as signed out. */
export function markStale(predicate) {
  return updateSessions((sessions) => {
    let changed = false;
    for (const session of Object.values(sessions)) {
      if (!session.stale && predicate(session)) {
        session.stale = true;
        changed = true;
      }
    }
    return changed;
  });
}

export function forgetAccount(login) {
  return updateSessions((sessions) => {
    delete sessions[String(login).toLowerCase()];
  });
}

/** cookies.onChanged listener. */
export function onCookieChanged({ cookie, removed, cause }) {
  if (!isGithubCookie(cookie) || (cookie.name !== "user_session" && cookie.name !== "dotcom_user")) return;
  if (cookie.name === "dotcom_user" && !isSwapping()) {
    // Signed in, out or switched on GitHub itself.
    readSessionCookies(cookie.storeId).then((cookies) => noteAccount(cookie.storeId, loginOf(cookies)), log);
  }
  if (!removed) {
    scheduleCapture(cookie.storeId);
  } else if (cookie.name === "user_session" && (cause === "expired_overwrite" || cause === "expired")) {
    // GitHub expires the cookie when the session ends (sign out, revoked session).
    markStale((s) => sessionValue(s.cookies) === cookie.value).catch(log);
  }
}
