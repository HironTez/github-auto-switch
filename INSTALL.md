# Build, install and configure

1. [Build](#1-build) the packages.
2. Install the one for your browser:
   - [Chrome, Edge, Brave, Opera, Vivaldi](#chrome-edge-brave-opera-vivaldi)
   - [Firefox](#firefox)
   - [Safari](#safari-macos)
3. [Configure](#3-configure) your accounts and rules.

## 1. Build

You need Node.js 20 or later and this repository.

```sh
npm install
npm test              # unit tests
npm run build
```

`npm run build` writes one package per browser family to `dist/`. Each contains only `manifest.json`,
`icons/` and `src/`, with the manifest trimmed to the keys that browser uses.

| Output | For |
|---|---|
| `dist/chromium/` and `dist/github-auto-switch-<version>-chromium.zip` | Chrome, Edge, Brave, Opera, Vivaldi |
| `dist/firefox/` and `dist/github-auto-switch-<version>-firefox.zip` | Firefox (121 or later) |
| `dist/safari/` | Safari, through Xcode (see [Safari](#safari-macos)) |

Before building a release for a store, raise `version` in `manifest.json`. Stores refuse a version they
already have, and browsers only update to a higher one.

Optional checks:

- `npm run lint` validates the Firefox package with Mozilla's linter.
- `npm run test:e2e:dist` runs the end-to-end test against the built Chromium package. It needs
  Playwright's Chromium, installed once with `npx playwright install chromium`.

## 2. Install

### Chrome, Edge, Brave, Opera, Vivaldi

**For yourself** (no store):

1. Move `dist/chromium/` to a place where it can stay, for example `~/Extensions/github-auto-switch`.
   The browser loads the extension from that folder each time it starts.
2. Open the extensions page:

   | Browser | Address |
   |---|---|
   | Chrome | `chrome://extensions` |
   | Edge | `edge://extensions` |
   | Brave | `brave://extensions` |
   | Opera | `opera://extensions` |
   | Vivaldi | `vivaldi://extensions` |

3. Turn on **Developer mode**, click **Load unpacked** and choose the folder.

To update, replace the folder's contents with a new `dist/chromium/` and click the extension's reload
button on the extensions page. Your accounts and rules stay. Keep the folder where it is: a folder
loaded from another place is another extension to the browser, with its own ID and empty storage, so
its accounts and rules start from scratch.

**Through a store:** upload `dist/github-auto-switch-<version>-chromium.zip` to the browser's store:

- Chrome Web Store: Developer Dashboard (one-time registration fee). Brave and Vivaldi install from
  the Chrome Web Store too.
- Microsoft Edge Add-ons: Partner Center.
- Opera add-ons: developer portal. Opera can also install from the Chrome Web Store after you add
  Opera's *Install Chrome Extensions* add-on.

### Firefox

Release versions of Firefox only keep extensions that Mozilla has signed. Signing is free and doesn't
publish anything unless you choose to.

**For yourself (signed, not listed publicly):**

1. Create an account on [addons.mozilla.org](https://addons.mozilla.org) and generate API credentials
   at <https://addons.mozilla.org/developers/addon/api/key/>.
   The add-on ID in `manifest.json` (`browser_specific_settings.gecko.id`) belongs to the first account
   that signs it. If that isn't you, change it to an ID of your own first, for example
   `github-auto-switch@<your-name>`. Keep it the same afterwards: Firefox keeps an add-on's accounts and
   rules under its ID.
2. Sign the package. This rebuilds `dist/firefox/`, has Mozilla sign it as an unlisted add-on, and saves
   the signed `.xpi` in `dist/`:

   ```sh
   export WEB_EXT_API_KEY=<issuer>
   read -rs WEB_EXT_API_SECRET && export WEB_EXT_API_SECRET   # paste the secret; it isn't shown or saved
   npm run sign:firefox
   ```

   Each signing needs a new `version` in `manifest.json`.
3. In Firefox, go to `about:addons` → gear menu → **Install Add-on From File…**, and choose the `.xpi`.

**Publicly:** submit `dist/github-auto-switch-<version>-firefox.zip` on addons.mozilla.org as a listed
add-on. Mozilla reviews it first.

**Just to try it**, without signing, use either option:

- Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `dist/firefox/manifest.json`.
  It stays until Firefox restarts.
- In Firefox Developer Edition, Nightly or ESR, set `xpinstall.signatures.required` to `false` in
  `about:config`, then install the zip from `about:addons` → **Install Add-on From File…**. This turns
  off signature checks for every add-on in that profile: set it back to `true` when you are done, and
  sign the extension as above to keep it.

Firefox before version 127 doesn't grant site access at install. Click **Allow access** in the
extension's popup or on its settings page.

### Safari (macOS)

You need Safari 18 or later, and Xcode (the full app from the App Store; the Command Line Tools alone
don't include the converter). The first time, point the developer tools at Xcode:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

1. Build and convert. The second command converts `dist/safari/` into an Xcode project in `dist/xcode/`,
   which Xcode then opens.

   ```sh
   npm install
   npm run build:safari
   ```

2. In Xcode, select the project in the navigator. For both targets (the app and the extension), go to
   **Signing & Capabilities** and choose your **Team**. A free personal team from your Apple ID is
   enough for your own Mac.
3. Make an app you can keep:
   1. **Product → Archive**.
   2. In the Organizer that opens, click **Distribute App** → **Custom** → **Copy App**, and save it.
   3. Move **GitHub Auto Switch.app** to `/Applications` and open it once. Safari then lists the
      extension.

   To try it quickly instead, use **Product → Run** (⌘R). The extension then runs from Xcode's build
   folder, which Xcode may clean up later.
4. In Safari → **Settings → Extensions**, turn on **GitHub Auto Switch**.
5. Give it access to GitHub: open github.com, click the extension's toolbar button and choose
   **Always Allow on This Website**.

If Safari doesn't list the extension, go to Safari → Settings → Advanced and turn on
*Show features for web developers*. Then use Develop → **Allow Unsigned Extensions**. Safari turns this
off again when it quits.

**To update:** pull the changes, run `npm run build:safari` again, and repeat steps 2 and 3, replacing
the app in `/Applications`. The app name stays the same, so Safari keeps your accounts and rules.

**For other people:** you need a paid Apple Developer Program membership. Either distribute through the
App Store (Archive → **Distribute App** → **App Store Connect**), or sign with Developer ID and
notarize (Archive → **Distribute App** → **Direct Distribution**).

## 3. Configure

The settings page opens when the extension is installed. You can open it later from the toolbar
button → **Rules and accounts**, or from the browser's extension settings.

### Let it reach github.com

The extension only works on `https://github.com/*`, and needs your permission there.

- **Chrome and other Chromium browsers:** granted at install. If you limited it, go to the extension's
  **Details** → **Site access** and choose *On specific sites* → `https://github.com`, or *On all sites*.
- **Firefox before 127:** click **Allow access** in the popup or on the settings page.
- **Safari:** *Always Allow on This Website* on github.com (see above).

The popup and the settings page show a warning while access is missing.

### Add your accounts

Open github.com once with each of your accounts. The extension remembers every account a GitHub page
is opened with. You don't need to sign in again:

- If you already use GitHub's account switcher (avatar menu → **Switch account**), switch to each of
  your accounts once.
- Otherwise, sign in to one account, then use avatar menu → **Add account** for the others. GitHub then
  keeps all of them signed in.

Each account appears under **Accounts** on the settings page and in the popup, marked **Ready**. An
account marked **Signed out** has a sign-in that GitHub ended. Sign in to it again on github.com and
the extension picks it up. **Forget** removes an account's saved sign-in.

### Set the rules

Under **Which account opens a page**, rules are checked from top to bottom, and the first match wins:

1. **Repository rules:** `owner/repo` → account. `*` matches any part of a name, for example
   `acme/deploy-*`.
2. **Owner rules:** an organization or user → account, for example `acme`. They also cover
   `github.com/orgs/acme/…`.
3. **Each account for its own content:** `github.com/<one of your accounts>/…` opens with that account.
4. **Default account:** everything else. Choose *none* to keep whichever account is signed in.

Patterns ignore case. Two more options:

- **Pages that belong to nobody** (dashboard, notifications, search, pull request lists): use the
  default account, or keep the current one.
- **Also switch when following links inside a GitHub tab:** switch for links clicked inside GitHub and
  for GitHub's in-page navigation, not only for pages loaded directly. It is on by default.

Sign-in pages and account settings (`/login`, `/sessions/…`, `/settings/…`) never switch.

Example for three accounts, `me`, `me-work` and `client-bot`:

| Setting | Value |
|---|---|
| Repository rule | `acme/deploy-*` → `client-bot` |
| Owner rule | `acme` → `me-work` |
| Each account for its own content | on |
| Default account | `me` |

Type a URL into **Try a URL** to see which account it will open with, and why.

### Day to day

- The toolbar button turns switching on or off. It also shows who is signed in now and which account
  the current tab uses.
- A browser has one signed-in GitHub account at a time, and only the tab in front switches it. When
  you return to a tab, its account comes back. The tab reloads if, while it was in the background, it
  loaded or sent updates with another account.
- To use two accounts side by side, use a separate browser profile for each, with the extension
  installed in each profile.
- A red **!** on the toolbar button means something needs your attention, usually an account to sign in
  to again. The popup says what.
- Saved sign-ins are kept unencrypted in the extension's storage, a plain file in your browser profile.
  Unlike the browser's own cookies, which Chromium browsers encrypt with the system keychain, any
  program running as you, and any copy or backup of the profile folder, can read them. Use **Forget**
  for accounts you no longer need. See [Permissions](README.md#permissions).
- If switching misbehaves, turn on **Activity log** on the settings page, reproduce the problem, and use
  **Copy**. See [Troubleshooting](README.md#troubleshooting).
