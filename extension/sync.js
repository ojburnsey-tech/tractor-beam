// Background sync: local history → server, settings and links ← server.
// Runs on change, every minute (chrome.alarms) and when the popup opens.
// Failures leave entries in the outbox; nothing is lost while offline.

import { history, outbox, inbox } from "./store.js";
import { getAccount, updateAccount, settings, dataKey, api, ApiError } from "./account.js";
import { seal, open } from "./lib/vault.js";
import { hostMatches } from "./lib/privacy.js";

const BATCH = 50;
const PRIVATE_FIELDS = ["title", "site", "pageUrl", "filename", "mediaHost", "errorMessage"];
const PUBLIC_FIELDS = [
  "id", "startedAt", "finishedAt", "state", "kind", "method", "mode", "live", "bytes", "received", "mediaDuration",
  "elapsedMs", "activeMs", "avgSpeed", "peakSpeed", "height", "codecs", "container", "fps", "concurrency",
  "concurrencyAuto", "errorCode", "samples"
];

let running = null;
let backoffUntil = 0;
let failures = 0;

/**
 * Saves a finished download. Incognito downloads are never stored. Sites on the
 * "never sync" list are kept on this computer only.
 */
export async function record(entry, { incognito = false } = {}) {
  if (incognito) return { stored: false };
  const prefs = await settings();
  const localOnly = hostMatches(entry.site, prefs.neverSync);
  await history.put({ ...entry, localOnly });
  await history.prune();
  if (!localOnly) await outbox.add(entry.id);
  syncSoon();
  return { stored: true, localOnly };
}

async function toWire(entry, key, encrypt) {
  const wire = {};
  for (const field of PUBLIC_FIELDS) if (entry[field] !== undefined) wire[field] = entry[field];
  const privateData = {};
  for (const field of PRIVATE_FIELDS) if (entry[field]) privateData[field] = entry[field];
  wire.sealed = await seal(privateData, { key, encrypt, aad: entry.id });
  // The title only travels in the clear when encryption is off.
  if (!encrypt && entry.title) wire.notifyTitle = String(entry.title).slice(0, 120);
  return wire;
}

async function push() {
  const prefs = await settings();
  const key = await dataKey();
  if (prefs.encryptHistory && !key) throw new ApiError("This browser is missing the encryption key. Connect it again.", 0, "no-key");
  while (true) {
    const ids = (await outbox.ids()).slice(0, BATCH);
    if (!ids.length) return;
    const entries = [];
    const missing = [];
    for (const id of ids) {
      const entry = await history.get(id);
      if (!entry || entry.localOnly || hostMatches(entry.site, prefs.neverSync)) missing.push(id);
      else entries.push(await toWire(entry, key, prefs.encryptHistory));
    }
    if (missing.length) await outbox.remove(missing);
    if (!entries.length) continue;
    const { json } = await api("/api/sync/push", { method: "POST", body: { entries } });
    // Rejected entries are malformed; retrying would loop forever.
    await outbox.remove([...json.accepted, ...json.rejected.map((item) => item.id).filter(Boolean)]);
  }
}

async function pull() {
  const account = await getAccount();
  const { json } = await api(`/api/sync/pull?since=${account.cursor || 0}`);
  if (json.deleted.length) await history.remove(json.deleted);

  const key = await dataKey();
  const known = new Map((await inbox.all()).map((item) => [item.id, item]));
  const fresh = [];
  for (const item of json.inbox) {
    if (known.has(item.id)) {
      known.delete(item.id);
      continue;
    }
    try {
      const data = await open(item.sealed, { key, aad: item.id });
      const stored = { id: item.id, url: String(data.url || ""), note: String(data.note || ""), createdAt: item.createdAt };
      await inbox.put(stored);
      fresh.push(stored);
    } catch {
      // Unreadable (e.g. sealed with an older key): skip rather than block sync.
    }
  }
  // Anything left was opened elsewhere or removed on the website.
  if (known.size) await inbox.remove([...known.keys()]);
  await updateAccount({ settings: json.settings, cursor: json.cursor, name: json.deviceName || account.name });
  return fresh;
}

/** Pulls then pushes. Concurrent calls share one run. */
export function syncNow({ force = false } = {}) {
  if (running) return running;
  if (!force && Date.now() < backoffUntil) return Promise.resolve({ skipped: true });
  running = (async () => {
    const account = await getAccount();
    if (!account) return { skipped: true };
    try {
      const fresh = await pull();
      await push();
      failures = 0;
      backoffUntil = 0;
      await updateAccount({ lastSync: Date.now(), status: "ok", message: "" });
      if (fresh.length) await announce(fresh);
      return { ok: true, fresh };
    } catch (error) {
      failures += 1;
      backoffUntil = Date.now() + Math.min(30000 * 2 ** (failures - 1), 15 * 60000);
      if (error.code !== "device-revoked") {
        await updateAccount({ status: error.code === "offline" ? "offline" : "error", message: error.message });
      }
      return { ok: false, error: error.message };
    } finally {
      running = null;
    }
  })();
  return running;
}

let soon = null;
export function syncSoon(delay = 1500) {
  clearTimeout(soon);
  soon = setTimeout(() => syncNow({ force: true }), delay);
}

async function announce(items) {
  const iconUrl = chrome.runtime.getURL("icons/icon128.png");
  for (const item of items.slice(0, 3)) {
    let host = "";
    try { host = new URL(item.url).hostname; } catch {}
    chrome.notifications.create(`inbox:${item.id}`, {
      type: "basic",
      iconUrl,
      title: "Link sent to this computer",
      message: item.note || host || item.url,
      contextMessage: "Click to open it",
      priority: 1
    });
  }
}

export async function pendingCount() {
  return (await outbox.ids()).length;
}
