// Unlocking the saved sign-ins (background/vault.js) from the popup, the settings page and the unlock
// page: a passphrase form, and a passkey whose PRF output unlocks without typing (Touch ID, Windows
// Hello). The passkey belongs to this extension; it signs in to nothing.

import { fromBase64, toBase64 } from "../lib/bytes.js";
import { el, sendMessage } from "./account.js";

const random = (length) => crypto.getRandomValues(new Uint8Array(length));
const MIN_PASSPHRASE = 8;

/** What the device calls its biometric unlock. */
export function biometricName() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  if (/mac/i.test(platform)) return "Touch ID";
  if (/win/i.test(platform)) return "Windows Hello";
  return "biometrics";
}

/** Whether this browser can offer a passkey on this device (it may still lack PRF; creating tells). */
export async function biometricsAvailable() {
  try {
    return Boolean(await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

const noPrf = () => new Error(`This browser can't unlock with ${biometricName()} (its passkeys have no PRF support).`);

/** The passkey's PRF output for `prfSalt`, after the user verified (base64). */
export async function passkeyPrf({ credentialId, prfSalt }) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: "public-key", id: fromBase64(credentialId) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: fromBase64(prfSalt) } } },
    },
  });
  const first = assertion?.getClientExtensionResults().prf?.results?.first;
  if (!first) throw noPrf();
  return toBase64(first);
}

/** Creates a passkey for unlocking: { credentialId, prfSalt, prf } (base64). */
export async function createPasskey() {
  const salt = random(32);
  const name = "GitHub Auto Switch";
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name },
      user: { id: random(16), name, displayName: name },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const results = credential?.getClientExtensionResults().prf;
  if (!results?.enabled) throw noPrf();
  const passkey = { credentialId: toBase64(credential.rawId), prfSalt: toBase64(salt) };
  // Some authenticators answer PRF only when the passkey is used, not when it is created.
  const first = results.results?.first;
  return { ...passkey, prf: first ? toBase64(first) : await passkeyPrf(passkey) };
}

/** A paragraph for errors, announced to screen readers. */
export const errorLine = () => el("p", { class: "error", role: "alert", hidden: true });

export function showError(line, error) {
  // A cancelled passkey prompt is not worth a message.
  const message = error && error.name !== "NotAllowedError" ? String(error.message ?? error) : "";
  line.textContent = message;
  line.hidden = !message;
}

/** Disables the controls in `form` while `job` runs. */
async function busy(form, job) {
  const controls = [...form.querySelectorAll("button, input")];
  for (const control of controls) control.disabled = true;
  try {
    return await job();
  } finally {
    for (const control of controls) control.disabled = false;
  }
}

/**
 * Passphrase field and, when a passkey is set up and `allowBiometric`, a biometric button. Calls
 * `onUnlocked` once unlocked. `allowBiometric: false` shows `biometricElsewhere` instead (the popup,
 * which would close during the passkey prompt).
 */
export function unlockForm({ biometric, onUnlocked, allowBiometric = true, biometricElsewhere }) {
  const input = el("input", {
    type: "password", autocomplete: "current-password", placeholder: "Passphrase", "aria-label": "Passphrase", required: true,
  });
  const error = errorLine();
  const form = el("form", { class: "unlock" }, el("div", { class: "row" }, input, el("button", { class: "primary", type: "submit" }, "Unlock")));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await busy(form, () => sendMessage({ type: "unlock", passphrase: input.value }));
      input.value = "";
      showError(error, null);
      onUnlocked?.();
    } catch (e) {
      showError(error, e);
      input.select();
    }
  });
  if (biometric && allowBiometric) {
    const button = el("button", { type: "button" }, `Unlock with ${biometricName()}`);
    button.addEventListener("click", async () => {
      try {
        await busy(form, async () => sendMessage({ type: "unlock", prf: await passkeyPrf(biometric) }));
        showError(error, null);
        onUnlocked?.();
      } catch (e) {
        showError(error, e);
      }
    });
    form.append(el("div", { class: "row" }, button));
  } else if (biometric && biometricElsewhere) {
    form.append(biometricElsewhere);
  }
  form.append(error);
  queueMicrotask(() => input.focus());
  return form;
}

/** Two passphrase fields (new and again) and a button; `onSet(passphrase)` when they agree. */
export function newPassphraseForm(label, onSet) {
  const first = el("input", {
    type: "password", autocomplete: "new-password", placeholder: "New passphrase", "aria-label": "New passphrase", required: true,
  });
  const again = el("input", {
    type: "password", autocomplete: "new-password", placeholder: "Again", "aria-label": "New passphrase again", required: true,
  });
  const error = errorLine();
  const form = el("form", { class: "unlock" }, el("div", { class: "row" }, first, again, el("button", { type: "submit" }, label)), error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if ([...first.value].length < MIN_PASSPHRASE) return showError(error, new Error(`Use at least ${MIN_PASSPHRASE} characters.`));
    if (first.value !== again.value) return showError(error, new Error("The two passphrases differ."));
    try {
      await busy(form, () => onSet(first.value));
      first.value = again.value = "";
      showError(error, null);
    } catch (e) {
      showError(error, e);
    }
  });
  return form;
}
