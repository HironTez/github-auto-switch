// End-to-end test: the real extension in Chromium against a fake github.com.
//
// The fake server behaves like GitHub where it matters: signing in sets the session cookies, every page
// carries <meta name="user-login">, and a revoked session makes it expire the cookies and render the
// page signed out. Chromium resolves github.com to the fake server.
//
// Run: npm run test:e2e   (needs `npx playwright install chromium` once)

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import forge from "node-forge";
import { chromium } from "playwright";

const EXTENSION = fileURLToPath(new URL("..", import.meta.url));

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
  res.writeHead(200, headers);
  res.end(`<!doctype html><html><head>
<meta name="user-login" content="${current}">
<title>${current || "(signed out)"} ${url.pathname}</title>
</head><body>${current || "signed out"} at ${url.pathname}</body></html>`);
}

// ---------------------------------------------------------------------------------------------------
// Browser

let server;
let context;
let worker;
let profile;

before(async () => {
  server = createServer(selfSignedCert(), handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  profile = mkdtempSync(join(tmpdir(), "gh-auto-switch-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // the full Chromium build: headless shell cannot load extensions
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=MAP github.com 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
});

after(async () => {
  await context?.close();
  server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

const storage = (area, key) => worker.evaluate(([a, k]) => chrome.storage[a].get(k).then((r) => r[k]), [area, key]);
const setSettings = (settings) => worker.evaluate((s) => chrome.storage.sync.set({ settings: s }), settings);

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

    const { login } = await open("https://github.com/bob/x");
    assert.equal(login, "carol", "falls back to the account that was signed in before");
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

  await t.test("turned off: nothing switches", async () => {
    await setSettings({ ...(await storage("sync", "settings")), enabled: false });
    assert.equal((await open("https://github.com/alice/x")).login, "dave");
  });
});
