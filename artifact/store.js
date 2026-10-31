// Library state for the artifact edition.
//
// Storage: the artifact's own database, under this viewer's private
// subtree (data/users/<id>/…), which nobody else can read, the artifact's
// owner included, even if the artifact is shared.
//   data/users/<id>/prefs                          download preferences
//   data/users/<id>/library/downloads/<entry id>   history
//   data/users/<id>/library/devices/<device id>    connected browsers
//   data/users/<id>/library/inbox/<item id>        links sent to a computer
//
// Live progress and remote control travel over the artifact's room: the
// Library page open on the computer that is downloading relays its jobs,
// and any other open Library (a phone) watches and sends commands back.
//
// The extension can't reach the internet-facing parts of claude.ai, so it
// talks to this page through bridge.js whenever the Library is open in the
// same browser; downloads made meanwhile wait in the extension's outbox.

import * as bridge from "./bridge.js";
import { LIBRARY_URL } from "./config.js";

export const DEFAULT_SETTINGS = {
  quality: "highest",
  mode: "both",
  concurrency: "auto",
  filenameTemplate: "{title}",
  neverSync: [],
  notifyFinished: true,
  notifyFailed: true
};

const listeners = new Map();

export const state = {
  available: null,
  unavailableReason: "",
  user: { email: "Your Library" },
  settings: { ...DEFAULT_SETTINGS },
  entries: [],
  entriesById: new Map(),
  loaded: false,
  devices: [],
  devicesLoaded: false,
  inbox: [],
  bridgeJobs: [],
  remoteJobs: new Map(),
  live: [],
  relays: new Map(),
  connection: "connecting",
  roomAvailable: false,
  writeError: ""
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

let db = null;
let room = null;
let downloadsApi = null;
let base = "";

const refs = {
  prefs: () => db.doc(`${base}/prefs`),
  downloads: () => db.doc(`${base}/library`).collection("downloads"),
  devices: () => db.doc(`${base}/library`).collection("devices"),
  inbox: () => db.doc(`${base}/library`).collection("inbox")
};

function plain(data) {
  return JSON.parse(JSON.stringify(data));
}

function reportWrite(error) {
  state.writeError = error?.code === "quota_exceeded"
    ? "Your Library is full. Delete some old downloads to make room."
    : error?.message || "A change couldn't be saved.";
  emit("write-error", state.writeError);
}

/** Runs async work over items, a few at a time. */
async function pool(items, worker, size = 4) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

// ---------- settings ----------

export async function updateSettings(changes) {
  const previous = state.settings;
  state.settings = { ...state.settings, ...changes };
  emit("settings");
  try {
    await refs.prefs().set(plain(state.settings));
    sendSettings();
  } catch (error) {
    state.settings = previous;
    emit("settings");
    throw new Error(error?.message || "Your settings couldn't be saved.");
  }
}

// ---------- history ----------

function indexEntries() {
  state.entries.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  state.entriesById = new Map(state.entries.map((entry) => [entry.id, entry]));
}

const ENTRY_FIELDS = [
  "id", "startedAt", "finishedAt", "state", "kind", "method", "mode", "live", "bytes", "received", "mediaDuration",
  "elapsedMs", "activeMs", "avgSpeed", "peakSpeed", "height", "codecs", "container", "fps", "concurrency",
  "concurrencyAuto", "errorCode", "samples", "title", "site", "pageUrl", "filename", "mediaHost", "errorMessage", "deviceId"
];
const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Keeps only known fields, so nothing unexpected is stored. */
function cleanEntry(raw, deviceId) {
  const entry = {};
  for (const field of ENTRY_FIELDS) if (raw[field] !== undefined && raw[field] !== null) entry[field] = raw[field];
  entry.id = String(raw.id || "");
  if (deviceId) entry.deviceId = deviceId;
  if (entry.samples && Array.isArray(entry.samples.values)) {
    entry.samples = { interval: Number(entry.samples.interval) || 1000, values: entry.samples.values.slice(0, 600) };
  }
  entry.savedAt = Date.now();
  return entry;
}

async function saveEntries(list, deviceId) {
  const saved = [];
  const rejected = [];
  await pool(list, async (raw) => {
    if (!raw || !VALID_ID.test(String(raw.id || ""))) {
      if (raw?.id) rejected.push(String(raw.id));
      return;
    }
    try {
      await refs.downloads().doc(raw.id).set(plain(cleanEntry(raw, deviceId)));
      saved.push(raw.id);
    } catch (error) {
      if (error?.code === "invalid_argument") rejected.push(raw.id);
      else reportWrite(error);
    }
  });
  return { saved, rejected };
}

export async function deleteEntry(id) {
  await refs.downloads().doc(id).delete();
  if (bridge.status.connected) bridge.post({ type: "deleted", ids: [id] });
}

export async function deleteAllEntries() {
  const ids = state.entries.map((entry) => entry.id);
  await pool(ids, (id) => refs.downloads().doc(id).delete(), 6);
  if (bridge.status.connected) bridge.post({ type: "deleted", ids });
}

/** Imports a history file exported from the extension (the fallback path). */
export async function importEntries(list) {
  if (!Array.isArray(list)) throw new Error("That file isn't an MP4 Grabber history export.");
  const fresh = list.filter((entry) => entry && VALID_ID.test(String(entry.id || "")) && !state.entriesById.has(entry.id));
  const { saved } = await saveEntries(fresh, null);
  return { imported: saved.length, skipped: list.length - saved.length };
}

/** Saves a file through the viewer's confirmation (artifact pages can't download directly). */
export async function saveFile(filename, text, type) {
  downloadsApi ||= await window.claude?.use?.("downloads");
  if (!downloadsApi) throw new Error("Saving files isn't available in this view.");
  return downloadsApi.save({ filename, data: new Blob([text], { type }) });
}

// ---------- browsers ----------

export async function removeDevice(id) {
  await refs.devices().doc(id).delete();
  if (bridge.status.connected && bridge.status.deviceId === id) bridge.post({ type: "unlink" });
}

export async function renameDevice(id, name) {
  await refs.devices().doc(id).update({ name: String(name).slice(0, 60) });
}

export function deviceName(id) {
  if (id && id === bridge.status.deviceId) return "This browser";
  return state.devices.find((device) => device.id === id)?.name || "A disconnected browser";
}

export function deviceOnline(id) {
  return (id && id === bridge.status.deviceId && bridge.status.connected) || state.relays.has(id);
}

export function connectBrowser() {
  return bridge.requestPairing(LIBRARY_URL);
}

// ---------- send to computer ----------

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sendLink({ url, note, targetDeviceId }) {
  const id = randomId();
  await refs.inbox().doc(id).set({ url, note: note || "", targetDeviceId: targetDeviceId || null, createdAt: Date.now(), openedAt: null, openedBy: null });
}

export async function removeLink(id) {
  await refs.inbox().doc(id).delete();
}

// ---------- live progress ----------

const REMOTE_STALE_MS = 9000;

function mergeLive() {
  const merged = new Map();
  const now = Date.now();
  for (const [deviceId, remote] of state.remoteJobs) {
    if (now - remote.at > REMOTE_STALE_MS || deviceId === bridge.status.deviceId) continue;
    for (const job of remote.jobs) merged.set(`${deviceId}:${job.jobId}`, { ...job, deviceId, deviceName: remote.deviceName });
  }
  for (const job of state.bridgeJobs) merged.set(`${bridge.status.deviceId}:${job.jobId}`, { ...job, deviceId: bridge.status.deviceId, local: true });
  state.live = [...merged.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  emit("live");
}

export async function command(job, action) {
  if (job.local && bridge.status.connected) {
    bridge.command(job.jobId, action);
    return;
  }
  if (!room) throw new Error("Live controls aren't available in this view.");
  await room.emit("command", { deviceId: job.deviceId, jobId: job.jobId, action });
}

/** Room messages are capped at 4 KB: send the essentials of up to three jobs. */
function compactJobs(jobs) {
  return jobs.slice(0, 3).map((job) => ({
    jobId: job.jobId, state: job.state, method: job.method, startedAt: job.startedAt, fraction: job.fraction,
    speed: Math.round(job.speed || 0), avgSpeed: Math.round(job.avgSpeed || 0), received: job.received, written: job.written,
    estimatedBytes: job.estimatedBytes, eta: job.eta, mediaDuration: job.mediaDuration, height: job.height, live: job.live,
    canPause: job.canPause, paused: job.paused, final: job.final, errorCode: job.errorCode,
    recent: (job.recent || []).slice(-48).map((value) => (value === null ? null : Math.round(value / 1000))),
    title: String(job.title || "").slice(0, 120), site: String(job.site || "").slice(0, 80)
  }));
}

let relayTimer = null;
let relayedEmpty = true;
function relayLive() {
  if (!room || !bridge.status.connected || relayTimer) return;
  relayTimer = setTimeout(async () => {
    relayTimer = null;
    const jobs = state.bridgeJobs;
    if (!jobs.length && relayedEmpty) return;
    relayedEmpty = !jobs.length;
    try {
      await room.emit("live", { deviceId: bridge.status.deviceId, deviceName: state.devices.find((device) => device.id === bridge.status.deviceId)?.name || "", jobs: compactJobs(jobs) });
    } catch {}
  }, 1500);
}

function receiveRemote(message) {
  const data = message?.data;
  if (!data || message.isMe || typeof data.deviceId !== "string" || !Array.isArray(data.jobs)) return;
  // The relayed `recent` series is sent in KB/s to fit the room's size limit.
  const jobs = data.jobs.slice(0, 3).map((job) => ({ ...job, recent: Array.isArray(job.recent) ? job.recent.map((value) => (value === null ? null : value * 1000)) : [] }));
  state.remoteJobs.set(data.deviceId, { at: Date.now(), deviceName: String(data.deviceName || ""), jobs });
  mergeLive();
}

// ---------- relay between the extension and the database ----------

function sendSettings() {
  if (bridge.status.connected) bridge.post({ type: "settings", settings: plain(state.settings) });
}

function sendInbox() {
  if (!bridge.status.connected) return;
  const mine = state.inbox
    .filter((item) => !item.openedAt && (!item.targetDeviceId || item.targetDeviceId === bridge.status.deviceId))
    .map((item) => ({ id: item.id, url: item.url, note: item.note, createdAt: item.createdAt }));
  bridge.post({ type: "inbox", items: mine });
}

const justPaired = new Set();

function checkRevoked() {
  const id = bridge.status.deviceId;
  if (!bridge.status.connected || !id || !state.devicesLoaded || justPaired.has(id)) return;
  if (!state.devices.some((device) => device.id === id)) bridge.post({ type: "unlink" });
}

async function touchDevice() {
  const id = bridge.status.deviceId;
  const device = state.devices.find((item) => item.id === id);
  if (!device || Date.now() - (device.lastSeen || 0) < 10 * 60 * 1000) return;
  try { await refs.devices().doc(id).update({ lastSeen: Date.now(), version: bridge.status.version || device.version || "" }); } catch {}
}

function wireBridge() {
  bridge.onJobs((jobs) => {
    state.bridgeJobs = jobs;
    mergeLive();
    relayLive();
  });
  bridge.onStatus(() => {
    if (!bridge.status.connected) state.bridgeJobs = [];
    mergeLive();
    emit("bridge");
    if (bridge.status.connected) {
      sendSettings();
      sendInbox();
      checkRevoked();
      touchDevice();
      bridge.syncNow();
      room?.presence({ relay: bridge.status.deviceId }).catch(() => {});
    }
  });
  bridge.onMessage("paired", async (message) => {
    const id = String(message.deviceId || "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return;
    justPaired.add(id);
    try {
      await refs.devices().doc(id).set({ name: String(message.name || "Chrome").slice(0, 60), browser: String(message.browser || "").slice(0, 120), version: String(message.version || ""), linkedAt: Date.now(), lastSeen: Date.now() });
    } catch (error) {
      reportWrite(error);
    }
    emit("paired", message);
  });
  bridge.onMessage("entries", async (message) => {
    if (!Array.isArray(message.entries) || !bridge.status.connected) return;
    const { saved, rejected } = await saveEntries(message.entries.slice(0, 100), bridge.status.deviceId);
    bridge.post({ type: "ack", batch: message.batch, ids: [...saved, ...rejected] });
  });
  bridge.onMessage("inbox-opened", async (message) => {
    const item = state.inbox.find((entry) => entry.id === message.id);
    if (!item || item.openedAt) return;
    try { await refs.inbox().doc(item.id).update({ openedAt: Date.now(), openedBy: bridge.status.deviceId }); } catch {}
  });
  bridge.onMessage("unlinked", async (message) => {
    // Disconnected from the extension's side: forget the browser here too.
    if (state.devices.some((device) => device.id === message.deviceId)) await refs.devices().doc(String(message.deviceId)).delete().catch(() => {});
  });
  bridge.onMessage("inbox-dismissed", async (message) => {
    if (state.inbox.some((entry) => entry.id === message.id)) await refs.inbox().doc(message.id).delete().catch(() => {});
  });
  bridge.start();
}

// ---------- start ----------

function watch(query, onData, label) {
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      state.connection = "connecting";
      emit("connection");
    }
  }, 10000);
  query.onSnapshot((snapshot) => {
    if (!snapshot.metadata.fromCache && !settled) {
      settled = true;
      clearTimeout(timer);
      state.connection = "live";
      emit("connection");
    }
    onData(snapshot);
  }, (error) => {
    clearTimeout(timer);
    console.error(`${label} stopped updating`, error);
    state.connection = "offline";
    emit("connection");
  });
}

/** Connects to the artifact's database. Resolves { available, reason }. */
export async function start() {
  const claude = window.claude;
  if (!claude?.use) return finishStart(false, "outside");
  const [database, user] = await Promise.all([claude.use("db"), claude.use("user")]);
  if (!database || !user) return finishStart(false, "no-db");
  const id = await user.id();
  if (!id) return finishStart(false, "signed-out");
  db = database;
  base = `data/users/${id}`;
  room = await claude.use("room").catch(() => null);
  state.roomAvailable = Boolean(room);

  watch(refs.prefs(), (snapshot) => {
    state.settings = { ...DEFAULT_SETTINGS, ...(snapshot.exists ? snapshot.data() : {}) };
    emit("settings");
    sendSettings();
  }, "Settings");
  watch(refs.downloads(), (snapshot) => {
    state.entries = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
    state.loaded = true;
    indexEntries();
    emit("entries");
  }, "History");
  watch(refs.devices(), (snapshot) => {
    state.devices = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id })).sort((a, b) => (a.linkedAt || 0) - (b.linkedAt || 0));
    if (!snapshot.metadata.fromCache) state.devicesLoaded = true;
    for (const device of state.devices) justPaired.delete(device.id);
    emit("devices");
    checkRevoked();
  }, "Browsers");
  watch(refs.inbox(), (snapshot) => {
    state.inbox = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    emit("inbox");
    sendInbox();
  }, "Sent links");

  if (room) {
    room.on("live", receiveRemote);
    room.on("command", (message) => {
      const data = message?.data;
      if (!data || data.deviceId !== bridge.status.deviceId || !bridge.status.connected) return;
      if (["pause", "resume", "cancel", "stop"].includes(data.action)) bridge.command(String(data.jobId), data.action);
    });
    room.onPeers((change) => {
      state.relays = new Map(change.peers.filter((peer) => typeof peer.presence?.relay === "string" && !peer.isMe).map((peer) => [peer.presence.relay, peer]));
      emit("devices");
    });
    setInterval(mergeLive, 3000);
  }
  wireBridge();
  return finishStart(true, "");
}

function finishStart(available, reason) {
  state.available = available;
  state.unavailableReason = reason;
  emit("session");
  return { available, reason };
}

export { bridge };
