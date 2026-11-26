// When the signed-in account changed, per cookie store, so the extension can tell whether a page sent
// requests while another account was signed in.
//
// { [store]: [{ at, login }] }, oldest first. `login` is null while a switch is under way and when
// nobody is signed in; either way a request sent then did not go out as any account's page.

import { sameLogin } from "../lib/rules.js";
import { sessionStore } from "./session-store.js";

const MAX_PER_STORE = 200;

/** A cookie store as a map key (undefined: the default store). */
export const storeKey = (storeId) => storeId ?? "";

const history = sessionStore("accountHistory", {
  load: (stored) => (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}),
  save: (all) => all,
});

/** Records that `login` (null: switching, or nobody) is signed in from now on. */
export function noteAccount(storeId, login, at = Date.now()) {
  return history.update((all) => {
    const list = (all[storeKey(storeId)] ??= []);
    if (list.length && list[list.length - 1].login === login) return;
    list.push({ at, login });
    if (list.length > MAX_PER_STORE) list.splice(0, list.length - MAX_PER_STORE);
  });
}

/**
 * The first of `times` (ms since 1970) at which another account than `login` was, or may have been,
 * signed in. Undefined when there is none, or nothing is known about those times.
 */
export async function requestAsOtherAccount(storeId, login, times = []) {
  const list = (await history.get())?.[storeKey(storeId)] ?? [];
  return times.find((t) => {
    const entry = list.findLast((e) => e.at <= t);
    return entry && !sameLogin(entry.login ?? "", login);
  });
}
