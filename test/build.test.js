import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseArgs, TARGETS } from "../scripts/targets.mjs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("the shared manifest has what each target picks from it", () => {
  assert.ok(manifest.background.service_worker);
  assert.ok(manifest.background.scripts?.length);
  assert.ok(manifest.browser_specific_settings?.gecko?.id);
});

for (const name of ["chromium", "safari"]) {
  test(`${name}: service worker only, no Firefox settings`, () => {
    const built = TARGETS[name].manifest(manifest);
    assert.deepEqual(built.background, { service_worker: manifest.background.service_worker, type: manifest.background.type });
    assert.equal("browser_specific_settings" in built, false);
    assert.deepEqual(built.permissions, manifest.permissions);
    assert.deepEqual(built.content_scripts, manifest.content_scripts);
  });
}

test("firefox: background scripts only, keeps its settings", () => {
  const built = TARGETS.firefox.manifest(manifest);
  assert.deepEqual(built.background, { scripts: manifest.background.scripts, type: manifest.background.type });
  assert.deepEqual(built.browser_specific_settings, manifest.browser_specific_settings);
});

test("transforms leave the shared manifest unchanged", () => {
  const before = structuredClone(manifest);
  for (const target of Object.values(TARGETS)) target.manifest(manifest);
  assert.deepEqual(manifest, before);
});

test("command line: targets and --xcode", () => {
  assert.deepEqual(parseArgs([], "linux"), { targets: ["chromium", "firefox", "safari"], xcode: false });
  assert.deepEqual(parseArgs(["firefox"], "linux"), { targets: ["firefox"], xcode: false });
  assert.deepEqual(parseArgs(["--xcode"], "darwin"), { targets: ["safari"], xcode: true });
  assert.deepEqual(parseArgs(["chromium", "--xcode"], "darwin"), { targets: ["chromium", "safari"], xcode: true });
  assert.deepEqual(parseArgs(["safari", "--xcode"], "darwin"), { targets: ["safari"], xcode: true });
});

test("command line: refuses what it doesn't know", () => {
  assert.throws(() => parseArgs(["--bogus"], "darwin"), /Unknown option "--bogus"/);
  assert.throws(() => parseArgs(["edge"], "darwin"), /Unknown target "edge"/);
  assert.throws(() => parseArgs(["constructor"], "darwin"), /Unknown target "constructor"/);
  assert.throws(() => parseArgs(["--xcode"], "linux"), /needs macOS/);
});
