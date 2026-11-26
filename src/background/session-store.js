// A value the background keeps across its own restarts: cached in memory, saved in storage.session
// where the browser has it (otherwise memory only).
//
// A change made while the stored value can't be read is not lost and doesn't overwrite it: it waits,
// and is applied (and saved) once a read succeeds. A failed write is tried again with the next change.
// (Settings and saved sign-ins, state.js, are different: their callers need the value itself, so a
// failed read reaches them as an error.)

import { log } from "./log.js";

/**
 * @param {string} key storage.session key.
 * @param {{ load: (stored: unknown) => T, save: (value: T) => unknown }} codec from and to what is stored.
 * @template T
 */
export function sessionStore(key, { load, save }) {
  let value = null;
  let saved; // JSON of what was last written
  const waiting = [];
  let queue = Promise.resolve();

  // One job at a time, so reads and writes never overlap.
  function run(job) {
    const result = queue.then(job);
    queue = result.catch(() => {});
    return result;
  }

  async function read() {
    if (!value) {
      const stored = chrome.storage.session ? (await chrome.storage.session.get(key))[key] : undefined;
      value = load(stored);
      saved = JSON.stringify(save(value));
    }
    for (const change of waiting.splice(0)) change(value);
  }

  async function write() {
    const json = JSON.stringify(save(value));
    if (json === saved) return;
    try {
      await chrome.storage.session?.set({ [key]: JSON.parse(json) });
      saved = json;
    } catch (error) {
      log(`${key} not saved:`, error);
    }
  }

  return {
    /**
     * Applies `change(value)` and saves the result. Resolves to what `change` returns, or undefined
     * when the value can't be read now (the change then waits).
     */
    update(change) {
      return run(async () => {
        try {
          await read();
        } catch (error) {
          log(`${key} not read:`, error);
          waiting.push(change);
          return undefined;
        }
        const result = change(value);
        await write();
        return result;
      });
    },
    /** The value once earlier changes are applied, or null when it can't be read now. */
    get() {
      return run(async () => {
        try {
          await read();
        } catch (error) {
          log(`${key} not read:`, error);
          return null;
        }
        await write(); // changes that waited for this read
        return value;
      });
    },
  };
}
