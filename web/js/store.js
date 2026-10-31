// Client-side state. Everything private arrives sealed and is opened here
// with the data key, so the server only ever stores ciphertext (when
// encryption is on). Views subscribe to named events and re-render.

import { get, post, patch, del, handleSignedOut } from "./api.js";
import { loadKey, saveKey, forgetKeys } from "./keystore.js";
import * as vault from "/shared/vault.js";
import * as bridge from "./bridge.js";

const listeners = new Map();

export const state = {
  signupOpen: false,
  user: null,
  key: null,
  settings: null,
  entries: [],
  entriesById: new Map(),
  cursor: 0,
  loaded: false,
  devices: [],
  inbox: [],
  serverJobs: [],
  bridgeJobs: [],
  live: [],
  connection: "connecting"
};

export function on(event, callback) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
  return () => listeners.get(event)?.delete(callback);
}

export function emit(event, detail) {
  for (const callback of listeners.get(event) || []) {
    try { callback(detail); } catch (error) { console.error(error); }
  }
}

// ---------- session ----------

export async function loadSession() {
  const result = await get("/api/auth/state");
  state.signupOpen = result.signupOpen;
  state.user = result.user;
  state.settings = result.user?.settings || null;
  state.key = state.user ? await loadKey(state.user.id) : null;
  return state;
}

async function unlockWith(user, email, password) {
  const { kek } = await vault.deriveAccountKeys(email, password, user.kdfIterations || vault.KDF_ITERATIONS);
  const key = await vault.unwrapDataKey(user.vault, kek);
  await saveKey(user.id, key);
  state.user = user;
  state.settings = user.settings;
  state.key = key;
  emit("session");
}

export async function signUp(email, password) {
  const { authHash, kek } = await vault.deriveAccountKeys(email, password);
  const dataKey = await vault.createDataKey();
  const { user } = await post("/api/auth/signup", { email, authHash, vault: await vault.wrapDataKey(dataKey, kek) });
  await saveKey(user.id, dataKey);
  state.user = user;
  state.settings = user.settings;
  state.key = dataKey;
  state.signupOpen = false;
  emit("session");
}

export async function signIn(email, password) {
  const { authHash } = await vault.deriveAccountKeys(email, password);
  const { user } = await post("/api/auth/signin", { email, authHash });
  await unlockWith(user, email, password);
}

/** Session cookie is valid but this browser has no key yet. */
export async function unlock(password) {
  const { user } = await get("/api/me");
  await unlockWith(user, user.email, password);
}

export async function signOut() {
  try { await post("/api/auth/signout"); } catch {}
  await resetLocal();
}

async function resetLocal() {
  await forgetKeys();
  stopEvents();
  Object.assign(state, { user: null, key: null, settings: null, entries: [], entriesById: new Map(), cursor: 0, loaded: false, devices: [], inbox: [], serverJobs: [], live: [] });
  emit("session");
}

handleSignedOut(() => {
  if (state.user) resetLocal();
});

export async function changePassword(currentPassword, newPassword) {
  const email = state.user.email;
  const current = await vault.deriveAccountKeys(email, currentPassword);
  const next = await vault.deriveAccountKeys(email, newPassword);
  await post("/api/me/password", { authHash: current.authHash, newAuthHash: next.authHash, vault: await vault.wrapDataKey(state.key, next.kek) });
  const { user } = await get("/api/me");
  state.user = user;
}

export async function deleteAccount(password) {
  const { authHash } = await vault.deriveAccountKeys(state.user.email, password);
  await post("/api/me/delete", { authHash });
  await resetLocal();
}

/** Checks a password locally (by unwrapping the vault) before risky actions. */
export async function verifyPassword(password) {
  const { kek } = await vault.deriveAccountKeys(state.user.email, password, state.user.kdfIterations);
  await vault.unwrapDataKey(state.user.vault, kek);
}

// ---------- settings ----------

export async function updateSettings(changes) {
  const previous = state.settings;
  state.settings = { ...state.settings, ...changes };
  emit("settings");
  try {
    const { settings } = await patch("/api/me/settings", { settings: changes });
    state.settings = settings;
    emit("settings");
  } catch (error) {
    state.settings = previous;
    emit("settings");
    throw error;
  }
}

/**
 * Turns history encryption on or off: every entry is re-sealed in this
 * browser, uploaded, and only then is the setting changed.
 */
export async function setEncryption(encrypt, onProgress = () => {}) {
  const entries = state.entries.filter((entry) => !entry.unreadable);
  for (let index = 0; index < entries.length; index += 200) {
    const chunk = entries.slice(index, index + 200);
    const sealed = await Promise.all(chunk.map(async (entry) => ({
      id: entry.id,
      sealed: await vault.seal(privateFields(entry), { key: state.key, encrypt, aad: entry.id })
    })));
    await post("/api/downloads/reseal", { entries: sealed });
    onProgress(Math.min(1, (index + chunk.length) / entries.length));
  }
  await updateSettings({ encryptHistory: encrypt });
  await refreshEntries({ full: true });
}

// ---------- history ----------

const PRIVATE = ["title", "site", "pageUrl", "filename", "mediaHost", "errorMessage"];

function privateFields(entry) {
  const data = {};
  for (const field of PRIVATE) if (entry[field]) data[field] = entry[field];
  return data;
}

async function openEntry(raw) {
  try {
    const data = await vault.open(raw.sealed, { key: state.key, aad: raw.id });
    return { ...raw, ...privateFields(data), encrypted: vault.isEncrypted(raw.sealed) };
  } catch {
    return { ...raw, unreadable: true, title: "Unreadable download", site: "" };
  }
}

function indexEntries() {
  state.entries.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  state.entriesById = new Map(state.entries.map((entry) => [entry.id, entry]));
}

let refreshing = null;
export function refreshEntries({ full = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const since = full ? 0 : state.cursor;
    const result = await get(`/api/downloads?since=${since}`);
    const opened = await Promise.all(result.entries.map(openEntry));
    if (full || !state.loaded) state.entries = opened;
    else {
      const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
      for (const entry of opened) byId.set(entry.id, entry);
      for (const id of result.deleted) byId.delete(id);
      state.entries = [...byId.values()];
    }
    state.cursor = result.cursor;
    state.loaded = true;
    indexEntries();
    emit("entries");
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function deleteEntry(id) {
  await del(`/api/downloads/${encodeURIComponent(id)}`);
  state.entries = state.entries.filter((entry) => entry.id !== id);
  indexEntries();
  emit("entries");
}

export async function deleteAllEntries() {
  await post("/api/downloads/delete-all");
  state.entries = [];
  indexEntries();
  emit("entries");
}

// ---------- devices ----------

export async function refreshDevices() {
  state.devices = (await get("/api/devices")).devices;
  emit("devices");
}

export async function renameDevice(id, name) {
  await patch(`/api/devices/${encodeURIComponent(id)}`, { name });
  await refreshDevices();
}

export async function removeDevice(id) {
  await del(`/api/devices/${encodeURIComponent(id)}`);
  await refreshDevices();
}

export function deviceName(id) {
  if (id && id === bridge.status.deviceId) return "This browser";
  return state.devices.find((device) => device.id === id)?.name || "A disconnected browser";
}

// ---------- send to computer ----------

export async function refreshInbox() {
  const { items } = await get("/api/inbox");
  state.inbox = await Promise.all(items.map(async (item) => {
    try {
      return { ...item, ...(await vault.open(item.sealed, { key: state.key, aad: item.id })) };
    } catch {
      return { ...item, url: "", note: "", unreadable: true };
    }
  }));
  emit("inbox");
}

export async function sendLink({ url, note, targetDeviceId }) {
  const id = vault.randomId(16);
  const sealed = await vault.seal({ url, note }, { key: state.key, encrypt: state.settings.encryptHistory, aad: id });
  await post("/api/inbox", { id, sealed, targetDeviceId: targetDeviceId || null });
  await refreshInbox();
}

export async function removeLink(id) {
  await del(`/api/inbox/${encodeURIComponent(id)}`);
  await refreshInbox();
}

// ---------- pairing ----------

export async function linkRequest(id) {
  return get(`/api/link/requests/${encodeURIComponent(id)}`);
}

export async function approveLink(request) {
  const wrappedKey = await vault.sealKeyForDevice(state.key, request.publicKey);
  await post(`/api/link/requests/${encodeURIComponent(request.id)}/approve`, { wrappedKey });
  await refreshDevices();
}

export async function declineLink(id) {
  await post(`/api/link/requests/${encodeURIComponent(id)}/decline`);
}

export const pairingCode = vault.pairingCode;

// ---------- live progress ----------

async function openJob(job) {
  if (!job.sealed) return { ...job, title: "", site: "" };
  try {
    return { ...job, ...(await vault.open(job.sealed, { key: state.key, aad: job.jobId })) };
  } catch {
    return { ...job, title: "", site: "" };
  }
}

function mergeLive() {
  const merged = new Map();
  for (const job of state.serverJobs) merged.set(`${job.deviceId}:${job.jobId}`, job);
  // This browser's own jobs come straight from the extension: fresher, and
  // shown even while the server is unreachable.
  for (const job of state.bridgeJobs) merged.set(`${bridge.status.deviceId}:${job.jobId}`, { ...job, deviceId: bridge.status.deviceId, local: true });
  state.live = [...merged.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  emit("live");
}

export async function command(job, action) {
  if (job.local && bridge.status.connected) {
    bridge.command(job.jobId, action);
    return;
  }
  await post("/api/live/command", { deviceId: job.deviceId, jobId: job.jobId, action });
}

bridge.onJobs((jobs) => {
  state.bridgeJobs = jobs;
  mergeLive();
});
bridge.onStatus(() => {
  if (!bridge.status.connected) state.bridgeJobs = [];
  mergeLive();
  emit("bridge");
});

// ---------- server events ----------

let source = null;
let entriesTimer = null;

function startEvents() {
  stopEvents();
  source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    state.connection = "live";
    emit("connection");
  });
  source.addEventListener("error", async () => {
    state.connection = "connecting";
    emit("connection");
    if (source?.readyState === EventSource.CLOSED) {
      // The server refused the stream: usually the session ended.
      try { await get("/api/me"); setTimeout(startEvents, 5000); } catch {}
    }
  });
  source.addEventListener("live", async (event) => {
    const { jobs } = JSON.parse(event.data);
    state.serverJobs = await Promise.all(jobs.map(openJob));
    mergeLive();
  });
  source.addEventListener("library", () => {
    clearTimeout(entriesTimer);
    entriesTimer = setTimeout(() => refreshEntries().catch(() => {}), 300);
  });
  source.addEventListener("inbox", () => refreshInbox().catch(() => {}));
  source.addEventListener("devices", () => refreshDevices().catch(() => {}));
  source.addEventListener("settings", (event) => {
    state.settings = JSON.parse(event.data).settings;
    emit("settings");
  });
  source.addEventListener("signed-out", () => resetLocal());
}

function stopEvents() {
  source?.close();
  source = null;
  state.connection = "connecting";
}

/** Loads everything once signed in and unlocked. */
export async function start() {
  startEvents();
  bridge.start();
  await Promise.all([refreshEntries({ full: true }), refreshDevices(), refreshInbox()]);
}

export { bridge };
