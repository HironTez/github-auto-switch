# GitHub Auto Switch

A browser extension that automatically switches between GitHub accounts.

One Manifest V3 codebase, no build step, for Chrome, Edge, Brave, Opera, Firefox and Safari.

## Layout

| Path | What |
|---|---|
| `manifest.json` | Shared manifest. `background` lists both `service_worker` (Chromium, Safari) and `scripts` (Firefox); each browser uses the key it supports. |
| `src/background.js` | Background logic. |
| `src/popup/` | Toolbar popup. |

Code uses the `chrome.*` namespace, which all target browsers support with promises in MV3.

## Development

```sh
npm install
npm run lint            # web-ext lint (Firefox validator)
npm run build           # zip into web-ext-artifacts/
npm run start:firefox   # launch Firefox with the extension
npm run start:chromium  # launch Chromium with the extension
```

Load unpacked by hand:

- **Chrome / Edge / Brave / Opera:** `chrome://extensions` → Developer mode → *Load unpacked* → repo root.
- **Firefox (121+):** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `manifest.json`.
- **Safari:** convert on macOS with Xcode: `xcrun safari-web-extension-converter .`

## Publishing

The zip from `npm run build` is uploaded to the Chrome Web Store, Edge Add-ons, Opera Add-ons and
addons.mozilla.org. Safari needs the converted Xcode project, submitted through App Store Connect.
