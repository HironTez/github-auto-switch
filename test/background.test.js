// Unit tests for parts of the background, against a small stand-in for the browser's extension APIs.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// Storage areas whose get() and set() can be made to fail.
function area() {
  const data = {};
  const store = {
    data,
    failGets: 0,
    failSets: 0,
    sets: 0,
    async get(key) {
      if (store.failGets > 0) {
        store.failGets--;
        throw new Error("storage unavailable");
      }
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      if (store.failSets > 0) {
        store.failSets--;
        throw new Error("storage full");
      }
      store.sets++;
      Object.assign(data, structuredClone(items));
    },
  };
  return store;
}

// A cookie jar for github.com whose set() can be made to fail on a given call. `hooks` run once, on
// the next call of their method (to make something happen while the background works).
const jar = new Map();
const hooks = {};
const runHook = (name) => {
  const hook = hooks[name];
  delete hooks[name];
  hook?.();
};
let cookieStores = [];
let setCalls = 0;
let failSetCall = 0;
const keyOf = (c) => `${c.name}|${c.domain}|${c.path}`;

globalThis.chrome = {
  runtime: { id: "ext", getURL: (path) => `chrome-extension://ext/${path}` },
  storage: {},
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  // One window. `status`: each tab's status; `page`: what tabs answer when asked for their page;
  // `asked` and `reloaded`: the tabs the background asked for their page and reloaded.
  tabs: {
    front: null,
    status: {},
    page: null,
    asked: [],
    reloaded: [],
    async query() {
      return chrome.tabs.front == null ? [] : [{ id: chrome.tabs.front }];
    },
    async get(tabId) {
      return { id: tabId, status: chrome.tabs.status[tabId] ?? "complete" };
    },
    async sendMessage(tabId, message) {
      runHook("sendMessage");
      chrome.tabs.asked.push(tabId);
      return message.type === "shownLogin" ? chrome.tabs.page : undefined;
    },
    async reload(tabId) {
      chrome.tabs.reloaded.push(tabId);
      onTabLoaded(tabId); // the page starts to arrive at once
    },
  },
  cookies: {
    async getAllCookieStores() {
      return cookieStores;
    },
    async getAll() {
      runHook("getAll");
      return [...jar.values()].map((c) => ({ ...c }));
    },
    async remove({ name }) {
      for (const [key, c] of jar) if (c.name === name) jar.delete(key);
    },
    async set(details) {
      runHook("set");
      setCalls++;
      if (setCalls === failSetCall) throw new Error("cookie not set");
      const hostOnly = details.domain == null;
      const cookie = {
        name: details.name, value: details.value, domain: details.domain ?? "github.com", hostOnly,
        path: details.path, secure: details.secure, httpOnly: details.httpOnly, sameSite: details.sameSite,
        session: false, expirationDate: details.expirationDate,
      };
      jar.set(keyOf(cookie), cookie);
    },
  },
};

// What the background logged as errors.
const errors = [];
console.error = (...args) => errors.push(args.map(String).join(" "));

beforeEach(() => {
  chrome.storage.sync = area();
  chrome.storage.local = area();
  chrome.storage.session = area();
  forgetChanged({ settings: {}, sessions: {} });
  chrome.tabs.front = null;
  chrome.tabs.status = {};
  chrome.tabs.page = null;
  chrome.tabs.asked = [];
  chrome.tabs.reloaded = [];
  for (const name of Object.keys(hooks)) delete hooks[name];
  cookieStores = [];
  errors.length = 0;
  jar.clear();
  setCalls = 0;
  failSetCall = 0;
});

const { swapTo, readLogin } = await import("../src/background/cookies.js");
const { getSettings, forgetChanged } = await import("../src/background/state.js");
const { createMessageHandler, fromExtensionPage } = await import("../src/background/messages.js");
const {
  handleNavigation, moment, noteLoadStart, onTabLoaded, restorePrevious, takeSkipped,
} = await import("../src/background/switching.js");
const { noteAccount } = await import("../src/background/history.js");
const { followIfFront } = await import("../src/background/front.js");
const { sessionStore } = await import("../src/background/session-store.js");

const handler = createMessageHandler({ onInPageNavigation: null });
const send = (message, sender) => new Promise((resolve) => handler(message, sender, resolve));
const POPUP = { id: "ext", url: "chrome-extension://ext/src/popup/popup.html" };
const pageIn = (tabId) => ({ id: "ext", url: "https://github.com/acme", tab: { id: tabId }, frameId: 0 });

const signIn = (login, token) => [
  { name: "logged_in", value: "yes", domain: ".github.com", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 4e9 },
  { name: "__Host-user_session_same_site", value: token, domain: "github.com", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "strict", session: false, expirationDate: 4e9 },
  { name: "user_session", value: token, domain: "github.com", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 4e9 },
  { name: "dotcom_user", value: login, domain: ".github.com", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 4e9 },
];
const signedIn = (login, token) => {
  for (const c of signIn(login, token)) jar.set(keyOf(c), c);
};
const saved = (...logins) => {
  chrome.storage.local.data.sessions = Object.fromEntries(
    logins.map((login) => [login, { login, cookies: signIn(login, login.toUpperCase()), updatedAt: 1, stale: false }]),
  );
};
const jarValues = () => Object.fromEntries([...jar].map(([key, c]) => [key, c.value]).sort());

test("swapTo puts the saved sign-in in place and drops the visit cookie", async () => {
  for (const c of signIn("alice", "A")) jar.set(keyOf(c), c);
  jar.set("_gh_sess|github.com|/", { name: "_gh_sess", value: "visit", domain: "github.com", hostOnly: true, path: "/" });
  await swapTo({ login: "bob", cookies: signIn("bob", "B") });
  assert.equal(await readLogin(), "bob");
  assert.equal(jar.get("user_session|github.com|/").value, "B");
  assert.equal(jar.has("_gh_sess|github.com|/"), false);
});

test("a swap that fails half way puts the previous sign-in back as it was", async () => {
  for (const c of signIn("alice", "A")) jar.set(keyOf(c), c);
  jar.set("_gh_sess|github.com|/", { name: "_gh_sess", value: "visit", domain: "github.com", hostOnly: true, path: "/" });
  const before = jarValues();
  failSetCall = 3; // logged_in and the same-site session are B's by then; user_session fails
  await assert.rejects(swapTo({ login: "bob", cookies: signIn("bob", "B") }), /cookie not set/);
  assert.deepEqual(jarValues(), before);
  assert.equal(await readLogin(), "alice");
});

test("a failed swap from signed out removes the cookies it had set", async () => {
  failSetCall = 4; // dotcom_user
  await assert.rejects(swapTo({ login: "bob", cookies: signIn("bob", "B") }));
  assert.deepEqual(jarValues(), {});
});

test("a failed settings read is tried again, not kept", async () => {
  forgetChanged({ settings: {} });
  chrome.storage.sync.failGets = 1;
  chrome.storage.local.failGets = 1; // the fallback area fails too
  await assert.rejects(getSettings());
  chrome.storage.sync.data.settings = { defaultAccount: "alice" };
  assert.equal((await getSettings()).defaultAccount, "alice");
});

test("account messages are accepted from the extension's pages only", () => {
  const page = (path) => `chrome-extension://ext/${path}`;
  assert.equal(fromExtensionPage({ id: "ext", url: page("src/popup/popup.html") }), true);
  assert.equal(fromExtensionPage({ id: "ext", url: page("src/options/options.html"), tab: { id: 3 } }), true);
  assert.equal(fromExtensionPage({ id: "ext", url: "https://github.com/acme", tab: { id: 3 }, frameId: 0 }), false);
  assert.equal(fromExtensionPage({ id: "ext", tab: { id: 3 } }), false);
  assert.equal(fromExtensionPage({ id: "ext" }), true);
  assert.equal(fromExtensionPage({ id: "other", url: page("x.html") }), false);
});

test("a change made while the stored value can't be read waits, and nothing is written over", async () => {
  const store = sessionStore("test-waits", { load: (stored) => stored ?? [], save: (list) => list });
  chrome.storage.session.data["test-waits"] = ["kept"];
  chrome.storage.session.failGets = 1;
  assert.equal(await store.update((list) => list.push("first")), undefined);
  assert.equal(chrome.storage.session.sets, 0, "nothing written");
  await store.update((list) => list.push("second"));
  assert.deepEqual(chrome.storage.session.data["test-waits"], ["kept", "first", "second"]);
  assert.deepEqual(await store.get(), ["kept", "first", "second"]);
});

test("a value is written only when it changed", async () => {
  const store = sessionStore("test-unchanged", { load: (stored) => stored ?? {}, save: (value) => value });
  await store.update(() => {});
  assert.equal(chrome.storage.session.sets, 0);
  await store.update((value) => { value.a = 1; });
  await store.update((value) => { value.a = 1; });
  assert.equal(chrome.storage.session.sets, 1);
});

test("changes that waited are saved by the next read", async () => {
  const store = sessionStore("test-get", { load: (stored) => stored ?? [], save: (list) => list });
  chrome.storage.session.failGets = 1;
  await store.update((list) => list.push("waited"));
  assert.deepEqual(await store.get(), ["waited"]);
  assert.deepEqual(chrome.storage.session.data["test-get"], ["waited"]);
});

test("a failed write is tried again with the next change", async () => {
  const store = sessionStore("test-retry", { load: (stored) => stored ?? {}, save: (value) => value });
  chrome.storage.session.failSets = 1;
  await store.update((value) => { value.a = 1; });
  assert.equal(chrome.storage.session.data["test-retry"], undefined);
  await store.update((value) => { value.a = 1; });
  assert.deepEqual(chrome.storage.session.data["test-retry"], { a: 1 });
});

test("a skipped mark that couldn't be read stays for the next time", async () => {
  // A module of its own, so that its marks haven't been read yet.
  const fresh = await import("../src/background/switching.js?skipped");
  chrome.storage.session.data.skippedTabs = [[7, {}], [8, { restore: "carol" }]];
  chrome.storage.session.failGets = 1;
  assert.equal(await fresh.takeSkipped(7), undefined);
  assert.equal(chrome.storage.session.sets, 0, "nothing written");
  assert.deepEqual(await fresh.takeSkipped(8), { restore: "carol" });
  assert.deepEqual(chrome.storage.session.data.skippedTabs, [[7, {}]]);
  assert.deepEqual(await fresh.takeSkipped(7), {});
});

test("GitHub pages can't remove accounts, read the signed-in one or clear problems", async () => {
  chrome.storage.local.data.sessions = { alice: { login: "alice", cookies: [] } };
  chrome.storage.local.data.status = { problem: "x", at: 1 };
  for (const type of ["removeAccount", "currentAccount", "clearProblem"]) {
    assert.deepEqual(await send({ type, login: "alice" }, pageIn(3)), { result: null });
  }
  assert.deepEqual(Object.keys(chrome.storage.local.data.sessions), ["alice"]);
  assert.equal(chrome.storage.local.data.status.problem, "x");

  assert.deepEqual(await send({ type: "removeAccount", login: "alice" }, POPUP), { result: null });
  assert.deepEqual(chrome.storage.local.data.sessions, {});
  assert.deepEqual(await send({ type: "clearProblem" }, POPUP), { result: null });
  assert.equal(chrome.storage.local.data.status.problem, null);
});

test("a message that fails is logged and answered with its error", async () => {
  chrome.storage.local.failGets = 1;
  const answer = await send({ type: "removeAccount", login: "alice" }, POPUP);
  assert.match(answer.error, /storage unavailable/);
  assert.ok(errors.some((e) => e.includes("message removeAccount:")), errors.join("\n"));
});

test("a page report that fails still follows the tab in front", async () => {
  chrome.tabs.front = 11;
  chrome.storage.local.failGets = 1; // the saved sign-ins can't be read
  const answer = await send({ type: "page", url: "https://github.com/acme", login: "" }, pageIn(11));
  assert.match(answer.error, /storage unavailable/);
  assert.deepEqual(chrome.tabs.asked, [11]);
});

test("a tab loading a page that hasn't reported yet is not asked about the page it leaves", async () => {
  chrome.tabs.front = 12;
  chrome.tabs.status[12] = "loading";
  noteLoadStart(12);
  await followIfFront(12);
  assert.deepEqual(chrome.tabs.asked, []);
  // Once the new page has reported, it counts as loaded, also while its images still load.
  await send({ type: "page", url: "https://github.com/acme", login: "" }, pageIn(12));
  assert.deepEqual(chrome.tabs.asked, [12]);
  // A load that ended without a page (status complete) is followed too.
  noteLoadStart(12);
  chrome.tabs.status[12] = "complete";
  await followIfFront(12);
  assert.deepEqual(chrome.tabs.asked, [12, 12]);
});

// A tab in front whose page (alice) sent a request while bob was signed in.
function pageWithRequestAsBob(tabId) {
  chrome.tabs.front = tabId;
  cookieStores = [{ id: `store${tabId}`, tabIds: [tabId] }];
  saved("alice", "bob");
  signedIn("alice", "ALICE");
  const t = Date.now() - 1000;
  noteAccount(`store${tabId}`, "bob", t);
  noteAccount(`store${tabId}`, "alice", t + 500);
  chrome.tabs.page = { login: "alice", url: "https://github.com/alice/x", requests: [t + 100] };
}

test("a page that sent requests as another account is reloaded when followed", async () => {
  pageWithRequestAsBob(30);
  await followIfFront(30);
  assert.deepEqual(chrome.tabs.reloaded, [30]);
});

test("a page isn't switched back or reloaded over a page the tab started loading meanwhile", async () => {
  pageWithRequestAsBob(31);
  signedIn("bob", "BOB"); // the page shows alice
  hooks.sendMessage = () => noteLoadStart(31); // before the follow is queued
  await followIfFront(31);
  assert.equal(await readLogin(), "bob", "not switched");
  pageWithRequestAsBob(32);
  hooks.getAll = () => noteLoadStart(32); // while the follow runs, right before the reload
  await followIfFront(32);
  assert.deepEqual(chrome.tabs.reloaded, []);
});

test("a wrong-account page is switched and reloaded, unless another page starts loading meanwhile", async () => {
  saved("alice", "bob");
  for (const tabId of [40, 41]) {
    chrome.tabs.front = tabId;
    signedIn("alice", "ALICE");
    if (tabId === 41) hooks.set = () => noteLoadStart(41); // while switching
    const switched = await handleNavigation(tabId, "https://github.com/bob/x", { mode: "page", pageLogin: "alice", seenAt: moment() });
    assert.equal(switched, true);
    assert.equal(await readLogin(), "bob");
  }
  assert.deepEqual(chrome.tabs.reloaded, [40]);
});

test("the page opened instead of a skipped reload is checked when it reports", async () => {
  saved("alice", "bob");
  chrome.tabs.front = 42;
  signedIn("alice", "ALICE");
  const docStart = Date.now() - 1; // the user's page started loading during the switch
  hooks.set = () => noteLoadStart(42);
  await handleNavigation(42, "https://github.com/bob/x", { mode: "page", pageLogin: "alice", seenAt: moment() });
  assert.deepEqual(chrome.tabs.reloaded, []);
  // It went out mid-switch and shows alice: switched again and reloaded.
  await send({ type: "page", url: "https://github.com/bob/x", login: "alice", docStart }, { ...pageIn(42), url: "https://github.com/bob/x" });
  assert.deepEqual(chrome.tabs.reloaded, [42]);
});

test("a rejected sign-in: the previous account comes back, after the signed-in one is saved", async () => {
  chrome.tabs.front = 50;
  saved("carol");
  signedIn("dave", "DAVE"); // not saved yet
  await restorePrevious(50, { previous: "carol" }, moment());
  assert.equal(await readLogin(), "carol");
  assert.equal(chrome.storage.local.data.sessions.dave?.login, "dave");
  assert.deepEqual(chrome.tabs.reloaded, [50]);
});

test("a rejected sign-in: nothing is restored once the tab started loading another page", async () => {
  saved("carol");
  signedIn("alice", "ALICE");
  for (const [tabId, front] of [[51, 51], [52, 99]]) {
    chrome.tabs.front = front;
    const seenAt = moment();
    noteLoadStart(tabId);
    await restorePrevious(tabId, { previous: "carol" }, seenAt);
    assert.equal(await takeSkipped(tabId), undefined, "no mark for its return");
  }
  assert.equal(await readLogin(), "alice");
  assert.deepEqual(chrome.tabs.reloaded, []);
});
