// Opened when the browser starts (with a passphrase set and "Ask to unlock" on), from the popup, or by
// the user. Closes its own tab once unlocked.

import { sendMessage } from "../ui/account.js";
import { unlockForm } from "../ui/unlock.js";

const $ = (id) => document.getElementById(id);

async function done() {
  $("form").replaceChildren();
  $("intro").hidden = true;
  $("done").hidden = false;
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  setTimeout(() => (tab?.id != null ? chrome.tabs.remove(tab.id).catch(() => window.close()) : window.close()), 800);
}

const status = await sendMessage({ type: "vaultStatus" });
if (!status.locked) await done();
else $("form").replaceChildren(unlockForm({ biometric: status.biometric, onUnlocked: done }));
