// Keeps the unwrapped data key in IndexedDB so a 30-day session doesn't ask
// for the password on every visit. Cleared on sign-out. The key is stored as
// a CryptoKey object (structured clone), never as text.

const DB = "grabber-web";
const STORE = "keys";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, work) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function loadKey(userId) {
  try {
    return (await run("readonly", (store) => store.get(userId))) || null;
  } catch {
    return null;
  }
}

export async function saveKey(userId, key) {
  try {
    await run("readwrite", (store) => store.put(key, userId));
  } catch {
    // Private browsing can refuse IndexedDB; the key then lives for this tab only.
  }
}

export async function forgetKeys() {
  try {
    await run("readwrite", (store) => store.clear());
  } catch {}
}
