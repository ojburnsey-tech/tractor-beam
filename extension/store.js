// IndexedDB storage for things that must survive a browser restart:
// download history, the sync outbox, received links and account secrets.
// Content scripts can't reach the extension's IndexedDB, which is why the
// device token and encryption key live here rather than in chrome.storage.

const DB_NAME = "grabber";
const VERSION = 1;
const LOCAL_HISTORY_LIMIT = 2000;
let opening;

function request(value) {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function database() {
  opening ||= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      const history = db.createObjectStore("history", { keyPath: "id" });
      history.createIndex("finishedAt", "finishedAt");
      db.createObjectStore("outbox", { keyPath: "id" });
      db.createObjectStore("inbox", { keyPath: "id" });
      db.createObjectStore("secrets", { keyPath: "name" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => {
      opening = null;
      reject(open.error);
    };
  });
  return opening;
}

async function run(storeName, mode, work) {
  const db = await database();
  const transaction = db.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const result = await work(store);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return result;
}

export const history = {
  put: (entry) => run("history", "readwrite", (store) => request(store.put(entry))),
  get: (id) => run("history", "readonly", (store) => request(store.get(id))),
  all: () => run("history", "readonly", (store) => request(store.getAll())),
  remove: (ids) => run("history", "readwrite", (store) => Promise.all(ids.map((id) => request(store.delete(id))))),
  clear: () => run("history", "readwrite", (store) => request(store.clear())),

  /** Newest first. */
  async recent(limit = 5) {
    return run("history", "readonly", (store) => new Promise((resolve, reject) => {
      const items = [];
      const cursor = store.index("finishedAt").openCursor(null, "prev");
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || items.length >= limit) return resolve(items);
        items.push(current.value);
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    }));
  },

  /** Keeps local history bounded; the server holds the full record. */
  async prune() {
    const all = await history.all();
    if (all.length <= LOCAL_HISTORY_LIMIT) return;
    const oldest = all.sort((a, b) => a.finishedAt - b.finishedAt).slice(0, all.length - LOCAL_HISTORY_LIMIT);
    await history.remove(oldest.map((entry) => entry.id));
  }
};

export const outbox = {
  add: (id) => run("outbox", "readwrite", (store) => request(store.put({ id, queuedAt: Date.now() }))),
  ids: () => run("outbox", "readonly", (store) => request(store.getAllKeys())),
  remove: (ids) => run("outbox", "readwrite", (store) => Promise.all(ids.map((id) => request(store.delete(id))))),
  clear: () => run("outbox", "readwrite", (store) => request(store.clear()))
};

export const inbox = {
  all: () => run("inbox", "readonly", (store) => request(store.getAll())),
  get: (id) => run("inbox", "readonly", (store) => request(store.get(id))),
  put: (item) => run("inbox", "readwrite", (store) => request(store.put(item))),
  remove: (ids) => run("inbox", "readwrite", (store) => Promise.all(ids.map((id) => request(store.delete(id))))),
  clear: () => run("inbox", "readwrite", (store) => request(store.clear()))
};

export const secrets = {
  async get(name) {
    return (await run("secrets", "readonly", (store) => request(store.get(name))))?.value ?? null;
  },
  set: (name, value) => run("secrets", "readwrite", (store) => request(store.put({ name, value }))),
  clear: () => run("secrets", "readwrite", (store) => request(store.clear()))
};
