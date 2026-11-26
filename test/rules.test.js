import assert from "node:assert/strict";
import { test } from "node:test";
import { globMatch, normalizeSettings, parseGithubUrl, resolveAccount } from "../src/lib/rules.js";

test("parseGithubUrl classifies pages", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/"), { kind: "general" });
  assert.deepEqual(parseGithubUrl("https://github.com/notifications?query=x"), { kind: "general" });
  assert.deepEqual(parseGithubUrl("https://github.com/pulls"), { kind: "general" });
  assert.deepEqual(parseGithubUrl("https://github.com/login?return_to=%2Facme"), { kind: "neutral" });
  assert.deepEqual(parseGithubUrl("https://github.com/settings/profile"), { kind: "neutral" });
  assert.deepEqual(parseGithubUrl("https://github.com/sessions/two-factor"), { kind: "neutral" });
  assert.deepEqual(parseGithubUrl("https://github.com/_side-panels/user"), { kind: "neutral" });
  assert.deepEqual(parseGithubUrl("https://github.com/favicon.ico"), { kind: "neutral" });
  assert.deepEqual(parseGithubUrl("https://github.com/octocat"), { kind: "owner", owner: "octocat", repo: null });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/web/pull/3#discussion"), {
    kind: "owner",
    owner: "acme",
    repo: "web",
  });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/web.git"), { kind: "owner", owner: "acme", repo: "web" });
  assert.deepEqual(parseGithubUrl("https://github.com/orgs/acme/people"), { kind: "owner", owner: "acme", repo: null });
  assert.deepEqual(parseGithubUrl("https://github.com/organizations/acme/settings/profile"), {
    kind: "owner",
    owner: "acme",
    repo: null,
  });
  assert.equal(parseGithubUrl("https://gist.github.com/acme"), null);
  assert.equal(parseGithubUrl("http://github.com/acme"), null);
  assert.equal(parseGithubUrl("not a url"), null);
});

test("globMatch is case-insensitive and keeps * inside one path segment", () => {
  assert.ok(globMatch("Acme", "acme"));
  assert.ok(globMatch("acme/*", "acme/web"));
  assert.ok(globMatch("acme/*-infra", "acme/cloud-infra"));
  assert.ok(globMatch("*/dotfiles", "anyone/dotfiles"));
  assert.ok(!globMatch("acme", "acme-labs"));
  assert.ok(!globMatch("acme*", "acme/web"));
  assert.ok(!globMatch("a.c", "abc"), "regex characters are literal");
});

const settings = normalizeSettings({
  defaultAccount: "main",
  ownContent: true,
  rules: [
    { type: "repo", pattern: "acme/secret", account: "z" },
    { type: "repo", pattern: "main/client-*", account: "y" },
    { type: "owner", pattern: "acme", account: "work" },
    { type: "owner", pattern: "", account: "ignored" },
    { type: "repo", pattern: "nobody", account: "ignored" },
  ],
});
const known = ["main", "Work", "y", "z"];
const accountFor = (url, s = settings) => resolveAccount(url, s, known)?.account ?? null;

test("resolveAccount: repository rules beat owner rules", () => {
  assert.equal(accountFor("https://github.com/acme/secret/issues"), "z");
  assert.equal(accountFor("https://github.com/acme/web"), "work");
  assert.equal(accountFor("https://github.com/orgs/acme/teams"), "work");
});

test("resolveAccount: rules beat own content", () => {
  assert.equal(accountFor("https://github.com/main/client-foo"), "y");
  assert.equal(accountFor("https://github.com/main/dotfiles"), "main");
});

test("resolveAccount: own content uses the account's own login, case-insensitively", () => {
  assert.equal(accountFor("https://github.com/work/notes"), "Work");
  assert.equal(accountFor("https://github.com/Y"), "y");
  assert.equal(accountFor("https://github.com/y", { ...settings, ownContent: false }), "main");
});

test("resolveAccount: default account for everything else", () => {
  assert.equal(accountFor("https://github.com/torvalds/linux"), "main");
  assert.equal(accountFor("https://github.com/"), "main");
  assert.equal(accountFor("https://github.com/notifications"), "main");
  assert.equal(accountFor("https://github.com/torvalds/linux", { ...settings, defaultAccount: "" }), null);
});

test("resolveAccount: general pages can keep the current account", () => {
  const keep = { ...settings, generalPages: "keep" };
  assert.equal(accountFor("https://github.com/notifications", keep), null);
  assert.equal(accountFor("https://github.com/torvalds/linux", keep), "main");
});

test("resolveAccount: never switches on sign-in, settings or non-GitHub pages", () => {
  assert.equal(accountFor("https://github.com/login"), null);
  assert.equal(accountFor("https://github.com/settings/tokens"), null);
  assert.equal(accountFor("https://example.com/acme/secret"), null);
});

test("resolveAccount: reasons explain the decision", () => {
  assert.equal(resolveAccount("https://github.com/acme/secret", settings, known).reason, "repository rule “acme/secret”");
  assert.equal(resolveAccount("https://github.com/acme/x", settings, known).reason, "owner rule “acme”");
  assert.equal(resolveAccount("https://github.com/z/x", settings, known).reason, "account’s own content");
  assert.equal(resolveAccount("https://github.com/q/x", settings, known).reason, "default account");
});

test("normalizeSettings tolerates missing and malformed data", () => {
  assert.deepEqual(normalizeSettings(undefined), {
    enabled: true,
    defaultAccount: "",
    ownContent: true,
    generalPages: "default",
    inPageNavigation: true,
    rules: [],
  });
  const s = normalizeSettings({ enabled: false, generalPages: "weird", rules: [null, { type: "x" }, { type: "owner" }] });
  assert.equal(s.enabled, false);
  assert.equal(s.generalPages, "default");
  assert.deepEqual(s.rules, [{ type: "owner", pattern: "", account: "" }]);
});
