# GitHub Auto Switch

A browser extension that does one thing: when you open a GitHub page, it switches to the GitHub
account your rules choose for that page.

For example:

- `my-main` for everything by default,
- each account for its own content (`github.com/my-work/...` opens as `my-work`),
- `my-work` for every repository of the `acme` organization,
- `client-bot` for `acme/deploy-*`.

One Manifest V3 codebase, no build step, for Chrome, Edge, Brave, Opera, Firefox and Safari.

## Setup

1. Install the extension (see [Install](#install)). Its settings page opens.
2. Open github.com once with each of your accounts. If you already use GitHub's account switcher
   (profile menu → *Switch account*), switching to each account once is enough; otherwise add them
   there with *Add account*, which keeps the other accounts signed in. The extension remembers every
   account a GitHub page is opened with (and the signed-in one whenever you open its popup).
3. On the settings page, set your rules.

## Rules

Checked in this order; the first match wins:

| | Rule | Matches |
|---|---|---|
| 1 | Repository rules | `owner/repo`, e.g. `acme/api` or `acme/deploy-*` |
| 2 | Owner rules | an organization or user, e.g. `acme`; also `github.com/orgs/acme/...` |
| 3 | Each account for its own content | `github.com/<one of your accounts>/...` |
| 4 | Default account | everything else |

Patterns ignore case. `*` matches any part of a single name and doesn't cross `/`.

Pages that belong to no owner (dashboard, notifications, search, pull request lists) use the default
account, or keep the current account if you choose that option. Sign-in pages and account settings
(`/login`, `/sessions/...`, `/settings/...`) never switch. The settings page has a **Try a URL** box
that shows which account a URL will open with, and why.

## How it works

GitHub keeps one signed-in account per browser profile, in a few cookies (`user_session`,
`__Host-user_session_same_site`, `dotcom_user`, `logged_in`). A switch also removes `_gh_sess`, GitHub's
per-visit state, which GitHub then starts anew for the account switched to.

- **Remembering accounts:** whenever those cookies change to a signed-in account, a GitHub page loads
  signed in, or you open the popup, the extension saves a copy for that account in its local storage.
- **Switching:** when a tab starts loading a github.com page, the extension asks the rules which account
  it should use. If that account isn't the signed-in one, it puts the account's saved cookies in place
  and restarts the load, so the page is served as the right account from the start. A clicked link in
  a GitHub tab that needs another account switches before the new page loads; in-page navigation that
  needs another account switches and reloads. You can turn both off.
- **Following the tab in front:** switching to a GitHub tab (or window) puts back the account its page
  was opened with, without reloading it, so its links and live updates keep working as that account.
  A page that loads in a background tab gives the account back to the tab in front once it has loaded.
- **Checking:** the content script reads the account the loaded page shows (`<meta name="user-login">`).
  It reports as soon as that tag arrives, before the rest of the page. If the page came with another
  account (for example, a response that was already on its way when the
  extension switched brought the old account's cookies back), it puts the sign-in in place again and
  reloads. If GitHub rejected the saved sign-in, the extension marks the account as signed out,
  restores the previous account and shows a red `!` on its toolbar icon.

It does not use GitHub's private APIs, and it sends nothing anywhere. Saved sign-ins stay in the
browser profile's extension storage and are never synced. Rules are stored in `storage.sync`, so they
follow your browser profile if you sync it.

### Limits

- **One account per profile at a time.** GitHub's cookies are shared by every tab, so the extension
  gives them to the tab in front. While a background tab loads a page of another account, the tab in
  front briefly runs as that account.
- **Typed URLs and links from outside GitHub** (other apps, other sites, new tabs) may show the old
  account first in browsers that can't hold a page load (Safari): the extension then switches and
  reloads. Links clicked inside GitHub switch before loading.
- **Signing out ends the saved sign-in.** *Sign out* on GitHub (or a session GitHub revokes) ends that
  account's session on GitHub's side. The extension notices and shows the account as *Signed out*.
  Sign in to it again and the extension picks it up.
- **Form submissions are never interrupted.** Only page loads (GET) are switched.
- **Private windows and Firefox containers** each have their own cookies. Switching works in them too,
  but accounts are remembered from wherever you signed in to them.
- **Safari** needs version 18 or later: older versions can't read or write GitHub's `HttpOnly` sign-in
  cookies. See [Safari](#safari).

## Install

From source, unpacked:

- **Chrome / Edge / Brave / Opera:** `chrome://extensions` → Developer mode → *Load unpacked* → this
  directory.
- **Firefox (121+):** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
  `manifest.json`. Firefox before 127 doesn't grant site access at install: click **Allow access** in
  the popup or on the settings page.
- **Safari:** see [Safari](#safari).

### Safari

Safari runs the same code, but needs a Mac with Xcode to package it as an app:

1. Install Xcode (the full app; the Command Line Tools alone don't include the converter), then point
   the tools at it: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
   Convert a clean copy of the extension, not the repository (which holds `node_modules` and tests):

   ```sh
   rm -rf build && mkdir -p build/extension
   cp -R manifest.json icons src build/extension/
   xcrun safari-web-extension-converter build/extension \
     --app-name "GitHub Auto Switch" --project-location build/xcode --macos-only --copy-resources
   ```

   Build and run the generated project in Xcode. For your own Mac, sign both targets with your Apple
   ID's personal team; publishing on the App Store needs a paid Apple Developer account. After
   changing the extension, convert again and rebuild.
2. Without signing: Safari → Settings → Advanced → *Show features for web developers*, then Develop →
   *Allow Unsigned Extensions* (Safari turns this off again when it quits).
3. Enable the extension in Safari → Settings → Extensions, and allow it on github.com (toolbar button
   → *Always Allow on This Website*).

How it differs from the other browsers (per MDN's compatibility data; not tested on a real Safari):

| Safari | Behaviour |
|---|---|
| before 18 | Doesn't work: the `cookies` API skips `HttpOnly` cookies, and GitHub's session cookie is one. |
| 18.0 – 18.3 | Works. No `webRequest` for Manifest V3, so a page that loads with the wrong account is reloaded once with the right one. |
| 18.4 and later | Works like the other browsers: switches before the page loads. |

In-page navigation is reported by the content script, because Safari has no
`webNavigation.onHistoryStateUpdated`. The toolbar badge shows `!` without its red background. The end-to-end
test runs these fallbacks by simulating the missing APIs in Chromium, not in Safari itself.

Permissions: `cookies` (save and switch the sign-in cookies), `webRequest` and `webNavigation` (notice
GitHub page loads and in-page navigation early), `storage`, and access to `https://github.com/*` only.
`src/lib/rules.js` is listed as web-accessible on github.com so the content script can load it; it holds
the matching code only, no settings or sign-ins.

## Layout

| Path | What |
|---|---|
| `manifest.json` | Shared manifest. `background` lists both `service_worker` (Chromium, Safari) and `scripts` (Firefox); each browser uses the key it supports. |
| `src/lib/rules.js` | URL classification and rule matching. Pure, no browser APIs. |
| `src/lib/storage.js` | Storage layout: settings, saved sign-ins, status. |
| `src/background.js` | Remembers accounts, switches, checks the result. |
| `src/content.js` | Reports which account a loaded page shows. |
| `src/options/` | Settings page: accounts, rules, URL tester. |
| `src/popup/` | Toolbar popup: on/off, current account, what this tab uses. |
| `src/ui/` | Styles and helpers shared by the popup and settings page. |
| `icons/` | Generated by `scripts/make-icons.mjs` (`npm run icons`). |
| `test/` | Unit tests for the rules; end-to-end test with Chromium and a fake github.com. |

Code uses the `chrome.*` namespace, which all target browsers support with promises in MV3. Extension
code is plain ES modules, so there is no build step.

## Development

```sh
npm install
npm test                # rule tests (node --test)
npm run test:e2e        # the extension in Chromium against a fake github.com
npm run lint            # web-ext lint (Firefox validator)
npm run build           # zip into web-ext-artifacts/
npm run start:firefox   # launch Firefox with the extension
npm run start:chromium  # launch Chromium with the extension
```

`npm run test:e2e` needs Playwright's Chromium (`npx playwright install chromium`). It runs a local HTTPS
server that behaves like github.com where it matters (sign-in cookies, `user-login` meta tag, revoked
sessions), makes Chromium resolve `github.com` to it, and checks every rule kind, in-page navigation,
recovery from a revoked session, and signing in to a new account.

## Publishing

The zip from `npm run build` is uploaded to the Chrome Web Store, Edge Add-ons, Opera Add-ons and
addons.mozilla.org. Safari needs the converted Xcode project, submitted through App Store Connect.
