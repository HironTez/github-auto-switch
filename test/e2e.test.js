// End-to-end test: the real extension in Chromium against a fake github.com.
//
// The fake server behaves like GitHub where it matters: signing in sets the session cookies, every page
// carries <meta name="user-login">, and a revoked session makes it expire the cookies and render the
// page signed out. Chromium resolves github.com to the fake server.
//
// Run: npm run test:e2e   (needs `npx playwright install chromium` once)
//
// SAFARI=1 (npm run test:e2e:safari) runs it all again with what Safari before 18.4 lacks taken away
// (webRequest, webNavigation.onHistoryStateUpdated), so the fallbacks are tested. Still Chromium.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import forge from "node-forge";
import { chromium } from "playwright";

// EXTENSION_DIR: test that copy instead of the source tree (npm run test:e2e:dist tests dist/chromium).
const SOURCE = process.env.EXTENSION_DIR
  ? fileURLToPath(new URL(`../${process.env.EXTENSION_DIR}/`, import.meta.url))
  : fileURLToPath(new URL("..", import.meta.url));
const SAFARI = process.env.SAFARI === "1";

/** A copy of the extension whose background sees no webRequest and no onHistoryStateUpdated. */
function safariLikeCopy() {
  const dir = mkdtempSync(join(tmpdir(), "gh-auto-switch-safari-"));
  for (const entry of ["manifest.json", "icons", "src"]) cpSync(join(SOURCE, entry), join(dir, entry), { recursive: true });
  writeFileSync(
    join(dir, "src/safari-like.js"),
    `Object.defineProperty(chrome, "webRequest", { value: undefined, configurable: true });
Object.defineProperty(chrome.webNavigation, "onHistoryStateUpdated", { value: undefined, configurable: true });
chrome.storage.local.set({ testApis: { webRequest: !!chrome.webRequest, history: !!chrome.webNavigation.onHistoryStateUpdated } });
`,
  );
  const background = join(dir, "src/background.js");
  writeFileSync(background, `import "./safari-like.js";\n${readFileSync(background, "utf8")}`);
  return dir;
}

const EXTENSION = SAFARI ? safariLikeCopy() : SOURCE;

// ---------------------------------------------------------------------------------------------------
// Fake github.com

function selfSignedCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: "commonName", value: "github.com" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "github.com" }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

const sessions = new Map(); // token -> login
const requests = []; // { path, login }

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name)
      .map(([name, ...rest]) => [name, rest.join("=")]),
  );
}

const YEAR = 365 * 86_400;
const signInCookies = (token, login) => [
  `user_session=${token}; Path=/; Max-Age=${14 * 86_400}; Secure; HttpOnly; SameSite=Lax`,
  `__Host-user_session_same_site=${token}; Path=/; Max-Age=${14 * 86_400}; Secure; HttpOnly; SameSite=Strict`,
  `logged_in=yes; Domain=github.com; Path=/; Max-Age=${YEAR}; Secure; HttpOnly; SameSite=Lax`,
  `dotcom_user=${login}; Domain=github.com; Path=/; Max-Age=${YEAR}; Secure; HttpOnly; SameSite=Lax`,
];
const signOutCookies = [
  "user_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly",
  "__Host-user_session_same_site=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly",
  `logged_in=no; Domain=github.com; Path=/; Max-Age=${YEAR}; Secure; HttpOnly; SameSite=Lax`,
];

function handle(req, res) {
  const url = new URL(req.url, "https://github.com");
  const [, action, login] = url.pathname.split("/");

  if (action === "__signin") {
    const token = randomBytes(12).toString("hex");
    sessions.set(token, login);
    // Like GitHub, signing in redirects to where the user was going (the dashboard by default).
    res.writeHead(302, { "Set-Cookie": signInCookies(token, login), Location: url.searchParams.get("to") ?? "/__signed-in" });
    return res.end();
  }
  if (action === "__revoke") {
    for (const [token, owner] of sessions) if (owner === login) sessions.delete(token);
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("revoked");
  }

  const token = parseCookies(req.headers.cookie).user_session;
  const current = (token && sessions.get(token)) || "";
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
  if (token && !current) headers["Set-Cookie"] = signOutCookies;
  requests.push({ path: url.pathname, login: current });
  // A request still under way when the tab comes to the front.
  const delay = url.pathname.endsWith("/slow") ? 1500 : url.pathname.endsWith("/stall") ? 6000 : 0;
  // A page that takes long to finish loading, like GitHub's with its many parts.
  const extra = url.pathname.endsWith("/heavy") ? `<img src="${url.pathname}/stall">` : "";
  setTimeout(() => {
    res.writeHead(200, headers);
    res.end(`<!doctype html><html><head>
<meta name="user-login" content="${current}">
<title>${current || "(signed out)"} ${url.pathname}</title>
</head><body>${current || "signed out"} at ${url.pathname}${extra}</body></html>`);
  }, delay);
}

// ---------------------------------------------------------------------------------------------------
// Browser

let server;
let context;
let worker; // where the tests call extension APIs: the background, or an extension page once it restarted
let profile;
let launchOptions;

before(async () => {
  server = createServer(selfSignedCert(), handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  profile = mkdtempSync(join(tmpdir(), "gh-auto-switch-e2e-"));
  launchOptions = {
    channel: "chromium", // the full Chromium build: headless shell cannot load extensions
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=MAP github.com 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
    ],
  };
  context = await chromium.launchPersistentContext(profile, launchOptions);
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
});

after(async () => {
  await context?.close();
  server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
  if (EXTENSION !== SOURCE) rmSync(EXTENSION, { recursive: true, force: true });
});

const storage = (area, key) => worker.evaluate(([a, k]) => chrome.storage[a].get(k).then((r) => r[k]), [area, key]);
const signedInNow = () =>
  worker.evaluate(() => chrome.cookies.get({ url: "https://github.com/", name: "dotcom_user" }).then((c) => c?.value));
const setSettings = (settings) => worker.evaluate((s) => chrome.storage.sync.set({ settings: s }), settings);

/** Whether a service worker answers (one that the browser stopped never does). */
const responds = (w) =>
  Promise.race([w.evaluate(() => true), new Promise((resolve) => setTimeout(resolve, 1000, false))]).catch(() => false);

async function waitFor(check, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${message} (last: ${JSON.stringify(last)})`);
}

/** Opens `url` in a new tab, like a click from another site, and returns the account the page shows. */
async function open(url, page) {
  page ??= await context.newPage();
  const path = new URL(url).pathname;
  // The extension may restart the load, which aborts this navigation: wait for the result instead.
  await page.goto(url).catch(() => {});
  await waitFor(async () => (await page.title().catch(() => "")).endsWith(` ${path}`), `page ${path} loaded`);
  // Give a correcting reload, if any, the chance to start and finish.
  await new Promise((r) => setTimeout(r, 700));
  await page.waitForLoadState("load");
  const [login] = (await page.title()).split(" ");
  return { login, page };
}

async function signIn(login) {
  const page = await context.newPage();
  await page.goto(`https://github.com/__signin/${login}`);
  await waitFor(async () => (await storage("local", "sessions"))?.[login], `${login} remembered`);
  await page.close();
}

// ---------------------------------------------------------------------------------------------------

test("switches accounts by the rules", async (t) => {
  if (SAFARI) {
    // Right after start, the worker may not have its extension APIs yet.
    const apis = await waitFor(() => storage("local", "testApis").catch(() => null), "Safari-like copy loaded");
    assert.deepEqual(apis, { webRequest: false, history: false }, "the APIs the extension sees");
  }
  for (const login of ["alice", "bob", "carol"]) await signIn(login);
  const remembered = await storage("local", "sessions");
  assert.deepEqual(Object.keys(remembered).sort(), ["alice", "bob", "carol"]);

  await setSettings({
    defaultAccount: "alice",
    ownContent: true,
    rules: [
      { type: "repo", pattern: "acme/special", account: "carol" },
      { type: "owner", pattern: "acme", account: "bob" },
    ],
  });

  await t.test("own content", async () => {
    assert.equal((await open("https://github.com/bob/dotfiles")).login, "bob");
    assert.equal((await open("https://github.com/carol")).login, "carol");
  });

  await t.test("owner rule", async () => {
    assert.equal((await open("https://github.com/acme/web/pulls")).login, "bob");
    assert.equal((await open("https://github.com/orgs/acme/people")).login, "bob");
  });

  await t.test("repository rule beats the owner rule", async () => {
    assert.equal((await open("https://github.com/acme/special")).login, "carol");
  });

  await t.test("default account for other owners and general pages", async () => {
    assert.equal((await open("https://github.com/torvalds/linux")).login, "alice");
    await open("https://github.com/bob");
    assert.equal((await open("https://github.com/notifications")).login, "alice");
  });

  await t.test("the page the extension restarted is the one served with the right account", async () => {
    const served = requests.filter((r) => r.path === "/acme/special");
    assert.equal(served.at(-1).login, "carol");
  });

  await t.test("settings pages never switch", async () => {
    await open("https://github.com/carol/x");
    assert.equal((await open("https://github.com/settings/profile")).login, "carol");
  });

  await t.test("in-page navigation switches and reloads", async () => {
    const { page } = await open("https://github.com/torvalds/linux");
    // Like GitHub: change the URL without a page load, then the title.
    await page.evaluate(() => {
      history.pushState({}, "", "/bob/notes");
      document.title = "loading";
    });
    await waitFor(async () => (await page.title().catch(() => "")) === "bob /bob/notes", "reloaded as bob");
  });

  await t.test("a revoked session is detected and the previous account restored", async () => {
    assert.equal((await open("https://github.com/carol/x")).login, "carol");
    await (await context.newPage()).goto("https://github.com/__revoke/bob");

    const page = await context.newPage();
    await page.goto("https://github.com/bob/x").catch(() => {});
    // The load that started as carol may show first; wait for the switch to bob to be rejected.
    await waitFor(async () => (await storage("local", "sessions")).bob.stale, "bob marked as signed out");
    await waitFor(
      async () => (await page.title().catch(() => "")) === "carol /bob/x",
      "falls back to the account that was signed in before",
    );
    const sessions = await storage("local", "sessions");
    assert.equal(sessions.bob.stale, true);
    assert.match((await storage("local", "status")).problem, /bob/);

    // With bob signed out, his pages keep the current account instead of trying again.
    assert.equal((await open("https://github.com/acme/web")).login, "carol");
  });

  await t.test("signing in again makes the account usable again", async () => {
    await signIn("bob");
    await waitFor(async () => (await storage("local", "sessions")).bob.stale === false, "bob ready again");
    assert.equal((await open("https://github.com/acme/web")).login, "bob");
  });

  await t.test("signing in to a new account is remembered even when the rules switch away at once", async () => {
    const page = await context.newPage();
    await page.goto("https://github.com/__signin/dave?to=/").catch(() => {});
    await waitFor(async () => (await page.title().catch(() => "")) === "alice /", "dashboard opened as alice (default)");
    assert.ok((await storage("local", "sessions")).dave, "dave remembered");
    assert.equal((await open("https://github.com/dave/repo")).login, "dave");
  });

  await t.test("an account already signed in is remembered by opening any GitHub page", async () => {
    // Like installing the extension while signed in: the sign-in cookies don't change any more.
    // Let the save that the last switch's cookie change scheduled (1 s later) happen first.
    await new Promise((r) => setTimeout(r, 1500));
    await worker.evaluate(() =>
      chrome.storage.local.get("sessions").then(({ sessions }) => {
        delete sessions.dave;
        return chrome.storage.local.set({ sessions });
      }),
    );
    // A settings page never switches, so only the page itself can make dave known.
    assert.equal((await open("https://github.com/settings/profile")).login, "dave");
    await waitFor(async () => (await storage("local", "sessions")).dave, "dave remembered from the page");
  });

  await t.test("a page served with another account's session is corrected without mixing up saved sign-ins", async () => {
    assert.equal((await open("https://github.com/bob/x")).login, "bob");
    await new Promise((r) => setTimeout(r, 1500)); // let pending saves happen
    // The saved sign-ins are sealed; the fake server knows the tokens, the hashes tell whose is whose.
    const hash = (token) => createHash("sha256").update(`token ${token}`).digest("base64");
    const before = await storage("local", "sessions");
    const carolToken = [...sessions.keys()].find((token) => hash(token) === before.carol.tokenHash);
    // Like a response that was on its way during a switch and set its own session cookie afterwards:
    // the cookies name bob, but carry carol's session, so GitHub serves pages as carol.
    await worker.evaluate(
      (value) => chrome.cookies.set({ url: "https://github.com/", name: "user_session", value, path: "/", secure: true, httpOnly: true, sameSite: "lax" }),
      carolToken,
    );
    const page = await context.newPage();
    await page.goto("https://github.com/bob/y").catch(() => {});
    await waitFor(async () => (await page.title().catch(() => "")) === "bob /bob/y", "reloaded as bob");
    await new Promise((r) => setTimeout(r, 1500));
    const after = await storage("local", "sessions");
    assert.equal(after.bob.tokenHash, before.bob.tokenHash, "bob's saved sign-in is still bob's");
    assert.equal(after.carol.tokenHash, before.carol.tokenHash, "carol's saved sign-in is still carol's");
  });

  await t.test("a clicked link that needs another account switches before the page loads", async () => {
    const { page, login } = await open("https://github.com/torvalds/linux");
    assert.equal(login, "alice");
    await page.evaluate(() => {
      const link = Object.assign(document.createElement("a"), { href: "/carol/clicked", id: "go", textContent: "go" });
      document.body.append(link);
    });
    await page.click("#go");
    await waitFor(async () => (await page.title().catch(() => "")) === "carol /carol/clicked", "opened as carol");
    const served = requests.filter((r) => r.path === "/carol/clicked").map((r) => r.login);
    assert.deepEqual(served, ["carol"], "never loaded with the wrong account");
  });

  await t.test("returning to a tab puts its account back without reloading it", async () => {
    const { page: aliceTab } = await open("https://github.com/torvalds/linux");
    assert.equal((await open("https://github.com/bob/z")).login, "bob");
    const loads = requests.filter((r) => r.path === "/torvalds/linux").length;
    await aliceTab.bringToFront();
    await waitFor(async () => (await signedInNow()) === "alice", "alice signed in again");
    await new Promise((resolve) => setTimeout(resolve, 4000)); // past the second check
    assert.equal(requests.filter((r) => r.path === "/torvalds/linux").length, loads, "no reload");
  });

  await t.test("a tab that sent requests as another account in the background is reloaded on return", async () => {
    const { page: aliceTab, login } = await open("https://github.com/torvalds/live");
    assert.equal(login, "alice");
    assert.equal((await open("https://github.com/bob/y")).login, "bob");
    // Like GitHub's polling and live updates, from the tab in the background.
    await aliceTab.evaluate(() => fetch("/torvalds/live/poll").then((r) => r.text()));
    assert.ok(requests.some((r) => r.path === "/torvalds/live/poll" && r.login === "bob"), "the request went out as bob");
    const loads = requests.filter((r) => r.path === "/torvalds/live" && r.login === "alice").length;
    await aliceTab.bringToFront();
    await waitFor(
      () => requests.filter((r) => r.path === "/torvalds/live" && r.login === "alice").length > loads,
      "reloaded as alice",
    );
    await waitFor(async () => (await signedInNow()) === "alice", "alice signed in");
  });

  await t.test("a request still under way when the tab comes to the front is caught by the second check", async () => {
    const { page: aliceTab } = await open("https://github.com/torvalds/focus");
    assert.equal((await open("https://github.com/bob/w")).login, "bob");
    const loads = requests.filter((r) => r.path === "/torvalds/focus" && r.login === "alice").length;
    // Sent as bob; it finishes, and so becomes visible to the page, only after the first check.
    aliceTab.evaluate(() => fetch("/torvalds/focus/slow").then((r) => r.text())).catch(() => {});
    await waitFor(() => requests.some((r) => r.path === "/torvalds/focus/slow" && r.login === "bob"), "request sent as bob");
    await aliceTab.bringToFront();
    await waitFor(
      () => requests.filter((r) => r.path === "/torvalds/focus" && r.login === "alice").length > loads,
      "reloaded as alice",
    );
  });

  await t.test("moving to another tab while a switched page is still loading puts that tab's account back at once", async () => {
    const { page: aliceTab, login } = await open("https://github.com/torvalds/quick");
    assert.equal(login, "alice");
    const carolTab = await context.newPage();
    carolTab.goto("https://github.com/carol/heavy").catch(() => {});
    await waitFor(() => requests.some((r) => r.path === "/carol/heavy" && r.login === "carol"), "carol's page served");
    await aliceTab.bringToFront(); // while carol's page is still loading
    await waitFor(async () => (await signedInNow()) === "alice", "alice signed in again", 2000);
    await carolTab.close();
  });

  await t.test("moving to another tab while a switched page waits for its response puts that tab's account back at once", async () => {
    const { page: aliceTab, login } = await open("https://github.com/torvalds/quick2");
    assert.equal(login, "alice");
    const carolTab = await context.newPage();
    carolTab.goto("https://github.com/carol/late/stall").catch(() => {});
    await waitFor(
      () => requests.some((r) => r.path === "/carol/late/stall" && r.login === "carol"),
      "carol's page requested",
      15_000,
    );
    await aliceTab.bringToFront(); // before carol's page has answered
    await waitFor(async () => (await signedInNow()) === "alice", "alice signed in again", 2000);
    await carolTab.close();
  });

  await t.test("a page loading in a background tab doesn't switch until it comes to the front", async () => {
    const { page: front } = await open("https://github.com/bob/front");
    await front.bringToFront();
    const tabId = await worker.evaluate(
      async () => (await chrome.tabs.create({ url: "https://github.com/carol/background", active: false })).id,
    );
    await waitFor(
      () => requests.some((r) => r.path === "/carol/background" && r.login === "bob"),
      "the background tab loaded as bob",
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await signedInNow(), "bob", "the tab in front keeps its account");
    assert.ok(!requests.some((r) => r.path === "/carol/background" && r.login === "carol"), "not switched in the background");

    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
    await waitFor(
      () => requests.some((r) => r.path === "/carol/background" && r.login === "carol"),
      "reloaded as carol once in front",
    );
    await waitFor(async () => (await signedInNow()) === "carol", "carol signed in");
  });

  await t.test("closing a tab whose switched page is still on its way doesn't hold the next switch", async () => {
    const stalled = await context.newPage();
    stalled.goto("https://github.com/carol/closed/stall").catch(() => {});
    await waitFor(
      () => requests.some((r) => r.path === "/carol/closed/stall" && r.login === "carol"),
      "carol's page requested",
    );
    await stalled.close(); // its response is 6 seconds away
    const started = Date.now();
    assert.equal((await open("https://github.com/bob/after-close")).login, "bob");
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  });

  await t.test("a tab that comes to the front while its switch is under way gets its account once it loads", async () => {
    const { page: aliceTab } = await open("https://github.com/torvalds/pending");
    const carolTab = await context.newPage();
    carolTab.goto("https://github.com/carol/pending/slow").catch(() => {});
    await waitFor(
      () => requests.some((r) => r.path === "/carol/pending/slow" && r.login === "carol"),
      "carol's page requested",
    );
    await aliceTab.bringToFront();
    await waitFor(async () => (await signedInNow()) === "alice", "alice signed in for the tab in front", 2000);
    await carolTab.bringToFront(); // its page is still on its way
    await waitFor(async () => (await carolTab.title().catch(() => "")).startsWith("carol "), "carol's page arrived");
    await waitFor(async () => (await signedInNow()) === "carol", "carol signed in again", 3000);
    await carolTab.close();
    await aliceTab.close();
  });

  await t.test("a background tab that comes to the front while it still loads is switched", async () => {
    const { page: front } = await open("https://github.com/bob/front2");
    await front.bringToFront();
    // The page reports at once, but loading goes on (an image that takes 6 seconds).
    const tabId = await worker.evaluate(
      async () => (await chrome.tabs.create({ url: "https://github.com/carol/still-loading/heavy", active: false })).id,
    );
    await waitFor(
      () => requests.some((r) => r.path === "/carol/still-loading/heavy" && r.login === "bob"),
      "the background tab loaded as bob",
    );
    await new Promise((resolve) => setTimeout(resolve, 1000)); // its report arrives while in the background
    assert.equal(await worker.evaluate(async (id) => (await chrome.tabs.get(id)).status, tabId), "loading");
    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
    await waitFor(
      () => requests.some((r) => r.path === "/carol/still-loading/heavy" && r.login === "carol"),
      "reloaded as carol once in front",
    );
    await worker.evaluate((id) => chrome.tabs.remove(id), tabId);
  });

  await t.test("a sign-in rejected after its tab left the front: the previous account comes back with the tab", async () => {
    const { page: aliceTab } = await open("https://github.com/torvalds/rejected");
    assert.equal((await open("https://github.com/carol/rejected")).login, "carol");
    await (await context.newPage()).goto("https://github.com/__revoke/bob");
    const bobTab = await context.newPage();
    bobTab.goto("https://github.com/bob/rejected/slow").catch(() => {});
    await waitFor(() => requests.some((r) => r.path === "/bob/rejected/slow" && r.login === ""), "bob's revoked session sent");
    await aliceTab.bringToFront(); // before bob's page has answered
    await waitFor(async () => (await bobTab.title().catch(() => "")) === "(signed out) /bob/rejected/slow", "bob's page signed out");
    await waitFor(async () => (await storage("local", "sessions")).bob.stale, "bob marked as signed out");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await bobTab.bringToFront();
    await waitFor(async () => (await bobTab.title().catch(() => "")) === "carol /bob/rejected/slow", "reloaded as carol, signed in before");
    await bobTab.close();
    await aliceTab.close();

    // GitHub's answer to bob's dead session reached the browser after alice was back, and ended her
    // sign-in in the browser too: sign in to both again.
    for (const login of ["alice", "bob"]) {
      await signIn(login);
      await waitFor(async () => (await storage("local", "sessions"))[login].stale === false, `${login} ready again`);
    }
  });

  await t.test("a background tab is still switched when it comes to the front after the browser stopped the background", async () => {
    const { page: front } = await open("https://github.com/bob/front3");
    await front.bringToFront();
    const url = "https://github.com/carol/after-restart";
    await worker.evaluate((u) => chrome.tabs.create({ url: u, active: false }), url);
    await waitFor(() => requests.some((r) => r.path === "/carol/after-restart" && r.login === "bob"), "loaded as bob");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const cdp = await context.newCDPSession(front);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await cdp.detach();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const stopped = worker;
    assert.equal(await responds(stopped), false, "the background stopped");
    const tab = context.pages().find((p) => p.url() === url);
    await tab.bringToFront(); // wakes the background
    await waitFor(() => requests.some((r) => r.path === "/carol/after-restart" && r.login === "carol"), "reloaded as carol");
    await tab.close();
    // Playwright doesn't attach to the restarted worker; the extension's own page has the same APIs.
    const extensionPage = await context.newPage();
    await extensionPage.goto(new URL("/src/options/options.html", stopped.url()).href);
    worker = extensionPage;
  });

  await t.test("the activity log records switches when turned on", async () => {
    await setSettings({ ...(await storage("sync", "settings")), activityLog: true });
    assert.equal((await open("https://github.com/bob/logged")).login, "bob");
    const activity = await waitFor(async () => {
      const entries = (await storage("local", "activity")) ?? [];
      return entries.some((e) => e.event === "page shows" && e.url.endsWith("/bob/logged")) && entries;
    }, "activity recorded");
    const switches = activity.filter((e) => e.event === "switched" && e.url.endsWith("/bob/logged"));
    assert.deepEqual(switches.map((e) => e.to), ["bob"], "one switch, and no second one from the replaced page");
    await setSettings({ ...(await storage("sync", "settings")), activityLog: false });
  });

  await t.test("saved sign-ins are encrypted: no session token in the extension's storage", async () => {
    const local = JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)));
    const saved = Object.values(await storage("local", "sessions"));
    assert.ok(saved.length >= 3 && saved.every((s) => s.sealed && !s.cookies));
    for (const token of sessions.keys()) assert.equal(local.includes(token), false);
  });

  await t.test("turned off: nothing switches", async () => {
    await setSettings({ ...(await storage("sync", "settings")), enabled: false });
    assert.equal((await open("https://github.com/alice/x")).login, "bob");
  });
});

// ---------------------------------------------------------------------------------------------------

test("a passphrase locks the sign-ins; a passkey or the passphrase unlocks them, also after a browser restart", async (t) => {
  await setSettings({ ...(await storage("sync", "settings")), enabled: true, inPageNavigation: false });
  const settingsUrl = new URL("/src/options/options.html", worker.url()).href;
  const options = await context.newPage();
  await options.goto(settingsUrl);

  await t.test("setting a passphrase on the settings page", async () => {
    await options.getByPlaceholder("New passphrase").fill("correct horse battery");
    await options.getByPlaceholder("Again").fill("correct horse battery");
    await options.getByRole("button", { name: "Set passphrase" }).click();
    await waitFor(async () => (await storage("local", "vault"))?.mode === "passphrase", "passphrase set");
    await options.getByRole("button", { name: "Lock now" }).waitFor();
  });

  await t.test("adding a passkey (Touch ID, Windows Hello; here a virtual one)", async () => {
    const cdp = await context.newCDPSession(options);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
      },
    });
    await options.reload(); // the Security section asks again whether a platform authenticator is there
    await options.getByRole("button", { name: /^Also unlock with / }).click();
    await waitFor(async () => (await storage("local", "vault")).biometric, "passkey added");
  });

  await t.test("locked: nothing switches; unlocking with the passkey switches the tab in front", async () => {
    await options.getByRole("button", { name: "Lock now" }).click();
    await waitFor(async () => !(await storage("session", "vaultKey")), "locked");
    const current = await signedInNow();
    const { page, login } = await open("https://github.com/carol/locked");
    assert.equal(login, current, "not switched while locked");

    await options.bringToFront();
    await options.getByRole("button", { name: /^Unlock with / }).click();
    await waitFor(async () => await storage("session", "vaultKey"), "unlocked");
    await page.bringToFront();
    await waitFor(async () => (await page.title().catch(() => "")) === "carol /carol/locked", "switched once unlocked");
    await page.close();
  });

  await t.test("after a browser restart: locked, and the unlock page asks for the passphrase", async () => {
    await options.close();
    await context.close();
    context = await chromium.launchPersistentContext(profile, launchOptions);
    const unlock = await waitFor(
      () => context.pages().find((p) => p.url().endsWith("/src/unlock/unlock.html")),
      "unlock page opened at start",
    );
    worker = unlock;
    assert.equal(await storage("session", "vaultKey"), undefined, "locked");
    const bobBefore = (await storage("local", "sessions")).bob;
    assert.ok(bobBefore.sealed, "sign-ins kept");

    await unlock.getByPlaceholder("Passphrase").fill("wrong passphrase");
    await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
    await unlock.getByText("Wrong passphrase.").waitFor();
    await unlock.getByPlaceholder("Passphrase").fill("correct horse battery");
    await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
    await waitFor(() => unlock.isClosed(), "unlock tab closed itself");

    const extensionPage = await context.newPage();
    await extensionPage.goto(settingsUrl);
    worker = extensionPage;
    assert.equal((await open("https://github.com/bob/after-unlock")).login, "bob");
  });
});
