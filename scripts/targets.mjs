// The browser families the build makes packages for, and its command line. The shared manifest.json
// lists both a service worker (Chromium, Safari) and background scripts (Firefox), and Firefox-only
// settings; each build keeps only what its browser uses, so neither complains about the other's keys.

function serviceWorkerOnly({ browser_specific_settings, ...manifest }) {
  const { service_worker, type } = manifest.background;
  return { ...manifest, background: { service_worker, type } };
}

function scriptsOnly(manifest) {
  const { scripts, type } = manifest.background;
  return { ...manifest, background: { scripts, type } };
}

/** Target name -> { manifest: transform, zip: whether to package it }. */
export const TARGETS = {
  chromium: { manifest: serviceWorkerOnly, zip: true },
  firefox: { manifest: scriptsOnly, zip: true },
  safari: { manifest: serviceWorkerOnly, zip: false },
};

/**
 * The build's command line: target names (default: all) and --xcode, which converts the Safari package
 * and so builds only that one unless others are named. Throws on anything else.
 * @returns {{ targets: string[], xcode: boolean }}
 */
export function parseArgs(args, platform = process.platform) {
  const unknownFlag = args.find((a) => a.startsWith("-") && a !== "--xcode");
  if (unknownFlag) throw new Error(`Unknown option "${unknownFlag}". The only option is --xcode.`);
  const xcode = args.includes("--xcode");
  const named = args.filter((a) => !a.startsWith("-"));
  const unknown = named.find((name) => !Object.hasOwn(TARGETS, name));
  if (unknown) throw new Error(`Unknown target "${unknown}". Use ${Object.keys(TARGETS).join(", ")}.`);
  if (xcode && platform !== "darwin") throw new Error("--xcode needs macOS with Xcode.");
  const wanted = [...named, ...(xcode ? ["safari"] : [])];
  return { targets: wanted.length ? [...new Set(wanted)] : Object.keys(TARGETS), xcode };
}
