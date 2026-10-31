// Background sync between this browser's history and the Library.
//
// Two kinds of Library:
//  • artifact (claude.ai): entries travel over the bridge to the Library page
//    while it's open in this browser; the page saves them and confirms.
//    Settings, sent links and deletions come back the same way.
//  • self-hosted server: entries are sealed and pushed over HTTPS; settings
//    and links are pulled.
// Runs on change, every minute (chrome.alarms), when the popup opens and
// when the Library page connects. Failures leave entries in the outbox.

import { history, outbox, inbox } from "./store.js";
import { getAccount, updateAccount, settings, dataKey, api, ApiError, DEFAULT_SETTINGS } from "./account.js";
import { seal, open } from "./lib/vault.js";
import { hostMatches } from "./lib/privacy.js";
import * as bridgeHost from "./bridge-host.js";

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

/** Next batch of entries that may leave this computer; drops the rest from the outbox. */
async function nextBatch(prefs) {
  const ids = (await outbox.ids()).slice(0, BATCH);
  const entries = [];
  const skip = [];
  for (const id of ids) {
    const entry = await history.get(id);
    if (!entry || entry.localOnly || hostMatches(entry.site, prefs.neverSync)) skip.push(id);
    else entries.push(entry);
  }
  if (skip.length) await outbox.remove(skip);
  return { ids, entries };
}

// ---------- links sent to this computer (both kinds of Library) ----------

/**
 * Takes the current list of links waiting for this browser. New ones are
 * stored and announced; ones no longer listed (opened elsewhere, removed)
 * are forgotten.
 */
export async function receiveInbox(items) {
  const known = new Map((await inbox.all()).map((item) => [item.id, item]));
  const fresh = [];
  for (const raw of items) {
    const id = String(raw?.id || "");
    if (!id) continue;
    if (known.has(id)) {
      known.delete(id);
      continue;
    }
    let url = "";
    try { url = new URL(String(raw.url || "")).href; } catch { continue; }
    if (!/^https?:/.test(url)) continue;
    const stored = { id, url, note: String(raw.note || "").slice(0, 80), createdAt: Number(raw.createdAt) || Date.now() };
    await inbox.put(stored);
    fresh.push(stored);
  }
  if (known.size) await inbox.remove([...known.keys()]);
  if (fresh.length) announce(fresh);
  return fresh;
}

export async function receiveSettings(next) {
  const clean = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (next[key] !== undefined) clean[key] = next[key];
  if (!Array.isArray(clean.neverSync)) clean.neverSync = [];
  await updateAccount({ settings: clean });
}

// ---------- artifact Library ----------

async function syncArtifact(account) {
  const waiting = (await outbox.ids()).length;
  if (!bridgeHost.libraryConnected()) {
    await updateAccount({ status: waiting ? "waiting" : "ok", message: waiting ? "Open your Library to save the downloads waiting here." : "" });
    return { ok: true, waiting: true };
  }
  const prefs = await settings();
  while (true) {
    const { ids, entries } = await nextBatch(prefs);
    if (!ids.length) break;
    if (!entries.length) continue;
    const payload = entries.map(({ localOnly, ...entry }) => entry);
    const saved = await bridgeHost.sendEntries(payload);
    if (!saved.length) throw new Error("Your Library couldn't save these downloads.");
    await outbox.remove(saved);
  }
  // Report links opened or dismissed here so the Library marks them.
  for (const item of await inbox.all()) {
    if (item.opened) bridgeHost.broadcast({ type: "inbox-opened", id: item.id });
    if (item.dismissed) bridgeHost.broadcast({ type: "inbox-dismissed", id: item.id });
  }
  await updateAccount({ lastSync: Date.now(), status: "ok", message: "" });
  return { ok: true };
}

// ---------- self-hosted Library ----------

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

async function pushToServer() {
  const prefs = await settings();
  const key = await dataKey();
  if (prefs.encryptHistory && !key) throw new ApiError("This browser is missing the encryption key. Connect it again.", 0, "no-key");
  while (true) {
    const { ids, entries } = await nextBatch(prefs);
    if (!ids.length) return;
    if (!entries.length) continue;
    const wire = await Promise.all(entries.map((entry) => toWire(entry, key, prefs.encryptHistory)));
    const { json } = await api("/api/sync/push", { method: "POST", body: { entries: wire } });
    // Rejected entries are malformed; retrying would loop forever.
    await outbox.remove([...json.accepted, ...json.rejected.map((item) => item.id).filter(Boolean)]);
  }
}

async function pullFromServer(account) {
  const { json } = await api(`/api/sync/pull?since=${account.cursor || 0}`);
  if (json.deleted.length) await history.remove(json.deleted);
  const key = await dataKey();
  const items = [];
  for (const item of json.inbox) {
    try {
      const data = await open(item.sealed, { key, aad: item.id });
      items.push({ id: item.id, url: data.url, note: data.note, createdAt: item.createdAt });
    } catch {
      // Unreadable (e.g. sealed with an older key): skip rather than block sync.
    }
  }
  await receiveInbox(items);
  await updateAccount({ settings: json.settings, cursor: json.cursor, name: json.deviceName || account.name });
}

async function syncServer(account) {
  await pullFromServer(account);
  await pushToServer();
  await updateAccount({ lastSync: Date.now(), status: "ok", message: "" });
  return { ok: true };
}

/** Syncs with whichever Library this browser is linked to. Concurrent calls share one run. */
export function syncNow({ force = false } = {}) {
  if (running) return running;
  if (!force && Date.now() < backoffUntil) return Promise.resolve({ skipped: true });
  running = (async () => {
    const account = await getAccount();
    if (!account) return { skipped: true };
    try {
      const result = account.mode === "artifact" ? await syncArtifact(account) : await syncServer(account);
      failures = 0;
      backoffUntil = 0;
      return result;
    } catch (error) {
      failures += 1;
      backoffUntil = Date.now() + Math.min(30000 * 2 ** (failures - 1), 15 * 60000);
      if (error.code !== "device-revoked" && await getAccount()) {
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

function announce(items) {
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
