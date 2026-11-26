# GitHub Auto Switch

A browser extension that does one thing: when you open a GitHub page, it switches to the GitHub
account your rules choose for that page.

For example:

- `my-main` for everything by default,
- each account for its own content (`github.com/my-work/...` opens as `my-work`),
- `my-work` for every repository of the `acme` organization,
- `client-bot` for `acme/deploy-*`.

One Manifest V3 codebase for Chrome, Edge, Brave, Opera, Vivaldi, Firefox and Safari. The build only copies files
and trims the manifest per browser.

## Setup

[INSTALL.md](INSTALL.md) explains how to build the extension for each browser, install it and configure
it. In short:

1. `npm install && npm run build`, then install the package from `dist/` for your browser.
2. Open github.com once with each of your accounts. If you already use GitHub's account switcher
   (profile menu → *Switch account*), switching to each account once is enough. The extension
   remembers every account a GitHub page is opened with.
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
- **Only the tab in front switches.** A page that loads in a background tab keeps the signed-in account,
  so the tab you are looking at is never signed out from under you.
- **Coming back to a tab:** switching to a GitHub tab (or window) puts back the account its page was
  opened with, without reloading it, so its links and live updates keep working as that account. The
  tab is reloaded instead when, while it was in the background:
  - its page loaded with another account than the rules choose, or
  - its page sent requests to github.com (polling, updates) while another account was signed in. The
    content script notes when the page's requests started (resource timing); the background notes when
    the signed-in account changed. A second check a few seconds later catches requests that were still
    under way when you switched to the tab.

  Switching to another tab never waits for a page that a switch is still loading in the tab you left.
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

- **One account per profile at a time.** GitHub's cookies are shared by every tab, and an extension
  can't give a single request other cookies, so tabs of different accounts can't run side by side. The
  extension gives the account to the tab in front, and reloads a tab on return when needed (above).
  For accounts open side by side, use a browser profile per account, with the extension in each.
- **Typed URLs and links from outside GitHub** (other apps, other sites, new tabs) may show the old
  account first in browsers that can't hold a page load (Safari): the extension then switches and
  reloads. Links clicked inside GitHub switch before loading.
- **Signing out ends the saved sign-in.** *Sign out* on GitHub (or a session GitHub revokes) ends that
  account's session on GitHub's side. The extension notices and shows the account as *Signed out*.
  Sign in to it again and the extension picks it up.
- **Form submissions are never interrupted.** Only page loads (GET) are switched.
- **Private windows and Firefox containers** each have their own cookies. Where the extension may run
  in them (Chrome: *Allow in Incognito*; Firefox: *Run in Private Windows*), it switches their cookies
  with the same saved sign-ins: an account saved in a normal window is used in a private window or
  container too, and the other way round. Signing out there (or GitHub ending that session) ends the
  sign-in everywhere. To keep accounts apart, use browser profiles instead.
- **Safari** needs version 18 or later: older versions can't read or write GitHub's `HttpOnly` sign-in
  cookies. See [Safari](#safari).

## Troubleshooting

Turn on **Activity log** on the settings page and reproduce the problem. The log shows, per tab, when a
GitHub page started loading, which account each page showed, every switch (from, to, why, how long it
took, what came next) and reports it ignored. **Copy** puts it on the clipboard. It stays in the
browser (`storage.local`, last 300 entries); turn it off when you are done.

Errors also go to the background's console: Chrome `chrome://extensions` → *service worker*; Firefox
`about:debugging` → *Inspect*; Safari: Settings → Advanced → *Show features for web developers*, then
Develop → *Web Extension Background Content* → GitHub Auto Switch.

## Safari

The same code runs in Safari. Packaging it as a Mac app needs Xcode; see
[INSTALL.md](INSTALL.md#safari-macos). How Safari differs from the other browsers, per MDN's
compatibility data (tested by simulating the missing APIs in Chromium, not in Safari itself):

| Safari | Behaviour |
|---|---|
| before 18 | Doesn't work: the `cookies` API skips `HttpOnly` cookies, and GitHub's session cookie is one. |
| 18.0 – 18.3 | Works. No `webRequest` for Manifest V3, so a page that loads with the wrong account is reloaded once with the right one. |
| 18.4 and later | Works like the other browsers: switches before the page loads. |

In-page navigation is reported by the content script, because Safari has no
`webNavigation.onHistoryStateUpdated`. The toolbar badge shows `!` without its red background.

## Permissions

`cookies` (save and switch the sign-in cookies), `webRequest` and `webNavigation` (notice GitHub page
loads and in-page navigation early), `storage`, and access to `https://github.com/*` only.
`src/lib/rules.js` is listed as web-accessible on github.com so the content script can load it; it holds
the matching code only, no settings or sign-ins.

Saved sign-ins (GitHub's session cookies) are kept unencrypted in `storage.local`, a plain file in the
browser profile. Chrome, Edge and the other Chromium browsers encrypt their own cookie store with a key
from the system keychain; Safari keeps its cookies inside its own sandbox; Firefox stores cookies
unencrypted too. So any program running as you, and any copy or backup of the profile folder, can read
every saved account's sign-in, without the keychain prompt that would guard the browser's own cookies.
Browsers give extensions no such key. Use **Forget** for accounts you no longer need.

GitHub's own scripts can't reach the saved sign-ins: the content script runs apart from the page. Code
that took over the browser's github.com process could, through the content script's access to the
extension's storage, read and change the saved sign-ins, and so make the extension sign you in to an
account of its choosing. Content scripts may send the background only what they need: they report
the pages they run in, read the settings and the names of the saved accounts (to tell which account a
link needs), and ask for a switch before a clicked link loads, which signs the whole profile in to the
account the rules choose for that link. Every other message (reading the signed-in account, removing
accounts, clearing problems) is accepted from the popup and the settings page only.

A page load that needs another account is restarted by the extension after switching. GitHub then sees
a navigation the browser started itself, as if typed in the address bar, also when a link on another
site started it. A link on another site can therefore open any GitHub page (a GET request) signed in
as the account the rules pick for it; it could do so with the account already signed in before.

## Layout

| Path | What |
|---|---|
| `manifest.json` | Shared manifest. `background` lists both `service_worker` (Chromium, Safari) and `scripts` (Firefox); the build keeps the one each browser uses. |
| `src/background.js` | Background entry: registers every listener. |
| `src/background/accounts.js` | Remembers accounts (saved sign-ins), notices signed-out ones. |
| `src/background/cookies.js` | Reads GitHub's sign-in cookies and puts a saved sign-in in place. |
| `src/background/switching.js` | Switches for page loads, clicks and in-page navigation; checks the page that arrives. |
| `src/background/front.js` | Puts back a tab's account when it comes to the front, or reloads it. |
| `src/background/session-store.js` | Values the background keeps across its own restarts (storage.session). |
| `src/background/history.js` | When the signed-in account changed, to tell which requests went out as which account. |
| `src/background/messages.js` | Messages from the content script, popup and settings page. |
| `src/background/state.js`, `log.js`, `problems.js` | Cached settings and sign-ins, activity log, toolbar problems. |
| `src/content.js` | Reports which account a page shows and when it sent requests; switches before clicked links load. |
| `src/lib/rules.js` | URL classification and rule matching. Pure, no browser APIs. |
| `src/lib/storage.js` | Storage layout: settings, saved sign-ins, status (and the other keys). |
| `src/options/`, `src/popup/`, `src/ui/` | Settings page, toolbar popup, and what they share. |
| `icons/` | Generated by `scripts/make-icons.mjs` (`npm run icons`). |
| `scripts/build.mjs`, `scripts/targets.mjs` | Builds the per-browser packages in `dist/` (`npm run build`). |
| `test/` | Unit tests (rules, build, parts of the background); end-to-end test with Chromium and a fake github.com. |

Code uses the `chrome.*` namespace, which all target browsers support with promises in MV3. Extension
code is plain ES modules; the build only copies files and trims the manifest.

## Development

```sh
npm install
npm test                 # unit tests (node --test)
npm run test:e2e         # the extension in Chromium against a fake github.com
npm run test:e2e:safari  # the same, with the APIs Safari before 18.4 lacks taken away
npm run test:e2e:dist    # the same, against the built dist/chromium package
npm run lint             # build and validate the Firefox package (web-ext lint)
npm run build            # packages for every browser in dist/ (see INSTALL.md)
npm run start:firefox    # launch Firefox with the extension from the source tree
npm run start:chromium   # launch Chromium with the extension from the source tree
```

The end-to-end tests need Playwright's Chromium (`npx playwright install chromium`). They run a local
HTTPS server that behaves like github.com where it matters (sign-in cookies, `user-login` meta tag,
revoked sessions), make Chromium resolve `github.com` to it, and check every rule kind, in-page
navigation, clicked links, tabs coming to the front, recovery from a revoked session, and signing in to
a new account.
