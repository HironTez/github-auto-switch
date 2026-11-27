// The saved sign-ins are kept encrypted ("sealed"); only what lists them stays readable: login, when
// saved, signed out or not, and hashes that tell sign-ins apart without revealing them.
//
// Sealing uses the vault's public key (ECDH P-256, then AES-GCM), so a sign-in can be saved at any time,
// also while the vault is locked. Opening one, to switch to it, needs the private key:
// - "device" (the default): a non-extractable WebCrypto key in the extension's IndexedDB (keystore.js).
//   Content scripts and anything that reads only the extension's storage can't open the sign-ins.
// - "passphrase": the private key is encrypted with a key derived from a passphrase (PBKDF2), and
//   optionally also with one from a passkey (WebAuthn PRF: Touch ID, Windows Hello). Unlocking keeps it
//   in storage.session, which the browser holds in memory and clears when it quits.
//
// storage.local "vault": { version: 1, mode, publicKey, askOnStart,
//   passphrase?: { salt, iterations, iv, data }, biometric?: { credentialId, prfSalt, iv, data } }
// A sign-in's "sealed": { epk, iv, data }, the login being authenticated data. All bytes base64.

import { fromBase64, toBase64 } from "../lib/bytes.js";
import { keyStore } from "./keystore.js";
import { log } from "./log.js";
import { cookieKey, sessionValue } from "./cookies.js";
import { updateSessions } from "./state.js";

const subtle = crypto.subtle;
const CURVE = { name: "ECDH", namedCurve: "P-256" };
const PBKDF2_ITERATIONS = 600_000;
const DEVICE_KEY = "device";
const SESSION_KEY = "vaultKey"; // storage.session: { publicKey, pkcs8 } while unlocked
const MIN_PASSPHRASE = 8;
const utf8 = new TextEncoder();
const random = (length) => crypto.getRandomValues(new Uint8Array(length));

export class LockedError extends Error {
  constructor() {
    super("Locked: unlock GitHub Auto Switch to switch accounts.");
    this.name = "LockedError";
  }
}

// ---------------------------------------------------------------------------------------------------
// Primitives

async function aesFromBits(bits, info, usages) {
  const base = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

async function encrypt(key, bytes, additionalData) {
  const iv = random(12);
  const data = await subtle.encrypt({ name: "AES-GCM", iv, ...(additionalData && { additionalData }) }, key, bytes);
  return { iv: toBase64(iv), data: toBase64(data) };
}

async function decrypt(key, { iv, data }, additionalData) {
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), ...(additionalData && { additionalData }) },
    key,
    fromBase64(data),
  );
  return new Uint8Array(plain);
}

const sealInfo = "github-auto-switch sign-in";
const loginData = (login) => utf8.encode(login.toLowerCase());

async function seal(publicKeyText, login, cookies) {
  const publicKey = await subtle.importKey("raw", fromBase64(publicKeyText), CURVE, false, []);
  const ephemeral = await subtle.generateKey(CURVE, true, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "ECDH", public: publicKey }, ephemeral.privateKey, 256);
  const key = await aesFromBits(bits, sealInfo, ["encrypt"]);
  const sealed = await encrypt(key, utf8.encode(JSON.stringify(cookies)), loginData(login));
  return { epk: toBase64(await subtle.exportKey("raw", ephemeral.publicKey)), ...sealed };
}

async function unseal(privateKey, login, sealed) {
  const ephemeral = await subtle.importKey("raw", fromBase64(sealed.epk), CURVE, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256);
  const key = await aesFromBits(bits, sealInfo, ["decrypt"]);
  return JSON.parse(new TextDecoder().decode(await decrypt(key, sealed, loginData(login))));
}

async function passphraseKey(passphrase, salt, iterations) {
  const base = await subtle.importKey("raw", utf8.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const biometricKey = (prf) => aesFromBits(prf, "github-auto-switch biometric unlock", ["encrypt", "decrypt"]);
const importPrivate = (pkcs8) => subtle.importKey("pkcs8", fromBase64(pkcs8), CURVE, false, ["deriveBits"]);

async function newKeys(extractable) {
  const pair = await subtle.generateKey(CURVE, extractable, ["deriveBits"]);
  return {
    privateKey: pair.privateKey,
    publicKey: toBase64(await subtle.exportKey("raw", pair.publicKey)),
    pkcs8: extractable ? toBase64(await subtle.exportKey("pkcs8", pair.privateKey)) : undefined,
  };
}

/** SHA-256 of `text`, base64. */
async function digest(text) {
  return toBase64(await subtle.digest("SHA-256", utf8.encode(text)));
}

/** Tells sign-ins apart without revealing them: a hash of the session token. */
export const hashToken = (token) => (token ? digest(`token ${token}`) : Promise.resolve(null));

/** A hash of every cookie's value: tells whether a sign-in is already saved as it is. */
export const fingerprintOf = (cookies) =>
  digest(cookies.map((c) => `${cookieKey(c)}=${c.value}`).sort().join("\n"));

// ---------------------------------------------------------------------------------------------------
// The vault

let vaultPromise = null;
// While unlocked (passphrase): { publicKey, privateKey, pkcs8 }.
let unlocked = null;

/**
 * A new device-mode vault. Where the browser gives the extension no IndexedDB (Firefox set to never
 * remember history), the key is kept in the vault itself: the sign-ins are then sealed for the
 * format's sake only. Settings warns about it.
 */
async function deviceVault(previous) {
  const vault = { version: 1, mode: "device", askOnStart: previous?.askOnStart ?? true };
  let keys = await newKeys(false);
  try {
    await keyStore.put(DEVICE_KEY, keys.privateKey);
  } catch (error) {
    log("no key store, keeping the key with the sign-ins:", error);
    keys = await newKeys(true);
    vault.storedKey = keys.pkcs8;
  }
  return { ...vault, publicKey: keys.publicKey };
}

async function loadOrCreate() {
  const { vault } = await chrome.storage.local.get("vault");
  if (vault?.version === 1) return vault;
  const created = await deviceVault();
  await chrome.storage.local.set({ vault: created });
  return created;
}

/** storage.local "vault", created (device mode) the first time. */
export function getVault() {
  vaultPromise ??= loadOrCreate().catch((error) => {
    vaultPromise = null;
    throw error;
  });
  return vaultPromise;
}

/** storage.onChanged: another context changed the vault. */
export function forgetVault() {
  vaultPromise = null;
}

async function storedUnlock() {
  if (!chrome.storage.session) return undefined;
  return (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
}

async function rememberUnlocked(publicKey, pkcs8) {
  unlocked = { publicKey, pkcs8, privateKey: await importPrivate(pkcs8) };
  await chrome.storage.session?.set({ [SESSION_KEY]: { publicKey, pkcs8 } });
}

async function forgetUnlocked() {
  unlocked = null;
  await chrome.storage.session?.remove(SESSION_KEY);
}

/** The private key and, in passphrase mode, its bytes (pkcs8). Throws LockedError when locked. */
async function privateKeyOf(vault) {
  if (vault.mode === "device") {
    if (vault.storedKey) return { privateKey: await importPrivate(vault.storedKey) };
    const privateKey = await keyStore.get(DEVICE_KEY);
    if (!privateKey) throw new Error("The key of the saved sign-ins is missing.");
    return { privateKey };
  }
  if (unlocked?.publicKey !== vault.publicKey) {
    const stored = await storedUnlock();
    if (stored?.publicKey !== vault.publicKey) throw new LockedError();
    unlocked = { ...stored, privateKey: await importPrivate(stored.pkcs8) };
  }
  return unlocked;
}

/** Whether switching has to wait for an unlock. */
export async function isLocked() {
  const vault = await getVault();
  if (vault.mode !== "passphrase") return false;
  return privateKeyOf(vault).then(() => false, (error) => error instanceof LockedError || Promise.reject(error));
}

/** What the settings page shows. */
export async function vaultStatus() {
  const vault = await getVault();
  return {
    mode: vault.mode,
    locked: await isLocked(),
    biometric: vault.biometric ? { credentialId: vault.biometric.credentialId, prfSalt: vault.biometric.prfSalt } : null,
    keyWithSignIns: Boolean(vault.storedKey),
    askOnStart: vault.askOnStart !== false,
  };
}

// ---------------------------------------------------------------------------------------------------
// Sign-ins

/**
 * The parts of a saved sign-in that depend on its cookies: { sealed, tokenHash, fingerprint }.
 * `publicKey`: the vault's (the default) or a new vault's.
 */
export async function sealSignIn(login, cookies, publicKey) {
  publicKey ??= (await getVault()).publicKey;
  return {
    sealed: await seal(publicKey, login, cookies),
    tokenHash: await hashToken(sessionValue(cookies)),
    fingerprint: await fingerprintOf(cookies),
  };
}

/** A saved sign-in's token hash; also of one saved before encryption. */
export const tokenHashOf = async (session) =>
  session.tokenHash ?? (Array.isArray(session.cookies) ? hashToken(sessionValue(session.cookies)) : null);

/** The cookies of a saved sign-in. Throws LockedError when locked. */
export async function openSignIn(session) {
  if (Array.isArray(session.cookies)) return session.cookies; // saved before encryption, until sealed
  const vault = await getVault();
  return unseal((await privateKeyOf(vault)).privateKey, session.login, session.sealed);
}

/**
 * A sign-in that can't be opened any more: kept as signed out, without what described the sealed
 * cookies, so that saving the account again (with the same session) makes it ready.
 */
function dropSealed(session) {
  delete session.sealed;
  delete session.tokenHash;
  delete session.fingerprint;
  session.stale = true;
}

/**
 * Seals every sign-in again for `next` (the vault after a key change from `current`), in `sessions`.
 * Fails, changing nothing, when the current key can't be had (locked, or the key store failed). A
 * sign-in that can't be opened with it is dropped (dropSealed).
 */
async function resealAll(sessions, current, next) {
  const { privateKey } = await privateKeyOf(current);
  for (const session of Object.values(sessions)) {
    let cookies = Array.isArray(session.cookies) ? session.cookies : null;
    if (!cookies && session.sealed) cookies = await unseal(privateKey, session.login, session.sealed).catch(() => null);
    delete session.cookies;
    if (cookies) Object.assign(session, await sealSignIn(session.login, cookies, next.publicKey));
    else if (session.sealed) dropSealed(session);
  }
}

/**
 * Changes the vault, and the sign-ins with it, in one storage write. `change(vault, sessions)` returns
 * null (nothing to change) or { vault, after? }; `after` runs once written, before the next change.
 */
function changeVault(change) {
  return updateSessions(async (sessions) => {
    const result = await change(await getVault(), sessions);
    if (!result) return false;
    return {
      alsoSave: { vault: result.vault },
      onSaved: async () => {
        vaultPromise = Promise.resolve(result.vault);
        await result.after?.();
      },
    };
  });
}

/**
 * At every start of the background: seals sign-ins saved before encryption, and starts over when the
 * device key is gone (the browser lost the extension's database): those sign-ins can't be opened.
 */
export function checkVault() {
  return changeVault(async (vault, sessions) => {
    const lost = vault.mode === "device" && !vault.storedKey && !(await keyStore.get(DEVICE_KEY));
    const plain = Object.values(sessions).some((s) => Array.isArray(s.cookies));
    if (!lost && !plain) return null;
    let next = vault;
    if (lost) {
      next = await deviceVault(vault);
      for (const session of Object.values(sessions)) if (session.sealed) dropSealed(session);
    }
    for (const session of Object.values(sessions)) {
      if (!Array.isArray(session.cookies)) continue;
      Object.assign(session, await sealSignIn(session.login, session.cookies, next.publicKey));
      delete session.cookies;
    }
    return { vault: next };
  });
}

// ---------------------------------------------------------------------------------------------------
// Passphrase and biometrics

function checkPassphrase(passphrase) {
  if (typeof passphrase !== "string" || [...passphrase].length < MIN_PASSPHRASE) {
    throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  }
}

/** Unlocks with { passphrase } or { prf } (the passkey's PRF output, base64). */
export async function unlock({ passphrase, prf }) {
  const vault = await getVault();
  if (vault.mode !== "passphrase") return;
  let pkcs8;
  try {
    if (typeof passphrase === "string") {
      const { salt, iterations } = vault.passphrase;
      pkcs8 = await decrypt(await passphraseKey(passphrase, fromBase64(salt), iterations), vault.passphrase);
    } else if (typeof prf === "string" && vault.biometric) {
      pkcs8 = await decrypt(await biometricKey(fromBase64(prf)), vault.biometric);
    } else {
      throw new Error("nothing to unlock with");
    }
  } catch {
    throw new Error(typeof passphrase === "string" ? "Wrong passphrase." : "Unlocking with biometrics did not work.");
  }
  await rememberUnlocked(vault.publicKey, toBase64(pkcs8));
}

/** Locks until the next unlock (passphrase mode). */
export async function lock() {
  await forgetUnlocked();
}

/** Sets or changes the passphrase. From device mode, every sign-in is sealed again with new keys. */
export async function setPassphrase(passphrase) {
  checkPassphrase(passphrase);
  return changeVault(async (vault, sessions) => {
    let keys;
    let next;
    if (vault.mode === "passphrase") {
      keys = { ...(await privateKeyOf(vault)), publicKey: vault.publicKey };
      next = { ...vault };
    } else {
      keys = await newKeys(true);
      next = { ...vault, mode: "passphrase", publicKey: keys.publicKey };
      delete next.biometric;
      delete next.storedKey;
      await resealAll(sessions, vault, next);
    }
    const salt = random(16);
    const key = await passphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
    next.passphrase = { salt: toBase64(salt), iterations: PBKDF2_ITERATIONS, ...(await encrypt(key, fromBase64(keys.pkcs8))) };
    await rememberUnlocked(next.publicKey, keys.pkcs8);
    const dropDeviceKey = () => keyStore.delete(DEVICE_KEY).catch(log);
    return { vault: next, after: vault.mode === "device" && !vault.storedKey ? dropDeviceKey : null };
  });
}

/** Back to device mode: no passphrase, no biometrics. Needs the vault unlocked. */
export function removePassphrase() {
  return changeVault(async (vault, sessions) => {
    if (vault.mode !== "passphrase") return null;
    await privateKeyOf(vault); // unlocked? (before a new device key is made)
    const next = await deviceVault(vault);
    await resealAll(sessions, vault, next);
    return { vault: next, after: forgetUnlocked };
  });
}

/**
 * For a forgotten passphrase: forgets every saved sign-in, the passphrase and the passkey, and starts
 * over without a passphrase. The accounts are saved again as GitHub pages open with them.
 */
export function resetVault() {
  return changeVault(async (vault, sessions) => {
    if (vault.mode !== "passphrase") return null;
    for (const key of Object.keys(sessions)) delete sessions[key];
    return { vault: await deviceVault(vault), after: forgetUnlocked };
  });
}

/** Lets a passkey unlock too: `prf` is its PRF output for `prfSalt` (all base64). Needs it unlocked. */
export async function addBiometric({ credentialId, prfSalt, prf }) {
  if (![credentialId, prfSalt, prf].every((v) => typeof v === "string" && v)) throw new Error("Incomplete passkey.");
  return changeVault(async (vault) => {
    if (vault.mode !== "passphrase") throw new Error("Set a passphrase first.");
    const { pkcs8 } = await privateKeyOf(vault);
    const wrapped = await encrypt(await biometricKey(fromBase64(prf)), fromBase64(pkcs8));
    return { vault: { ...vault, biometric: { credentialId, prfSalt, ...wrapped } } };
  });
}

export function removeBiometric() {
  return changeVault(async (vault) => {
    if (!vault.biometric) return null;
    const next = { ...vault };
    delete next.biometric;
    return { vault: next };
  });
}

export function setAskOnStart(askOnStart) {
  return changeVault(async (vault) => ({ vault: { ...vault, askOnStart: Boolean(askOnStart) } }));
}

/** Whether to ask for the passphrase now that the browser has started. */
export async function shouldAskToUnlock() {
  const vault = await getVault();
  return vault.mode === "passphrase" && vault.askOnStart !== false && (await isLocked());
}
