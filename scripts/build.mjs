// Builds the extension for each browser family into dist/:
//
//   dist/chromium/  + dist/github-auto-switch-<version>-chromium.zip   Chrome, Edge, Brave, Opera, Vivaldi
//   dist/firefox/   + dist/github-auto-switch-<version>-firefox.zip    Firefox
//   dist/safari/                                                         input for Xcode's converter
//
// Each holds only what the extension needs (manifest.json, icons/, src/), with the manifest trimmed to
// the keys that browser uses (targets.mjs).
//
//   node scripts/build.mjs [chromium] [firefox] [safari]   only these (default: all)
//   node scripts/build.mjs --xcode                         build only safari, and convert dist/safari into an
//                                                          Xcode project in dist/xcode (macOS with Xcode)

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import webExt from "web-ext";
import { parseArgs, TARGETS } from "./targets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const CONTENTS = ["manifest.json", "icons", "src"];
const APP_NAME = "GitHub Auto Switch";

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

let targets, xcode;
try {
  ({ targets, xcode } = parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

for (const name of targets) {
  const target = TARGETS[name];
  const dir = join(DIST, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const entry of CONTENTS) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(target.manifest(manifest), null, 2)}\n`);

  let built = `dist/${name}/`;
  if (target.zip) {
    const filename = `github-auto-switch-${manifest.version}-${name}.zip`;
    await webExt.cmd.build(
      { sourceDir: dir, artifactsDir: DIST, filename, overwriteDest: true },
      { showReadyMessage: false, shouldExitProgram: false },
    );
    built += ` and dist/${filename}`;
  }
  console.log(`${name.padEnd(8)} ${manifest.version}: ${built}`);
}

if (xcode) {
  const project = join(DIST, "xcode");
  rmSync(project, { recursive: true, force: true });
  execFileSync(
    "xcrun",
    [
      "safari-web-extension-converter", join(DIST, "safari"),
      "--app-name", APP_NAME, "--project-location", project, "--macos-only", "--copy-resources",
    ],
    { stdio: "inherit" },
  );
}
