// Keys the extension keeps as WebCrypto key objects, in its own IndexedDB. A key made non-extractable
// stays that way: scripts can use it but never read its bytes. Content scripts can't reach this
// database at all (it belongs to the extension's origin, not to GitHub's).

const DB = "github-auto-switch";
const STORE = "keys";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const indexedDbStore = {
  get: (name) => run("readonly", (store) => store.get(name)),
  put: (name, key) => run("readwrite", (store) => store.put(key, name)),
  delete: (name) => run("readwrite", (store) => store.delete(name)),
};

/** The store in use: IndexedDB, or a stand-in (tests). */
export let keyStore = indexedDbStore;
export function useKeyStore(store) {
  keyStore = store;
}
