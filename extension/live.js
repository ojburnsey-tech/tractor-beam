// Live progress relay (background).
//
// Download tabs report snapshots here. They're forwarded at once to any
// website tab connected through the bridge, and every two seconds to the
// server so other devices can watch. Commands come back from both paths.

import { getAccount, settings, dataKey, api } from "./account.js";
import { seal } from "./lib/vault.js";

const SERVER_INTERVAL = 2000;
const LINGER_MS = 6000; // finished jobs stay visible briefly so they can be seen landing

const jobs = new Map();      // jobId → snapshot (plaintext, local only)
const ended = new Set();     // jobIds to tell the server about
const ports = new Set();     // accepted website bridges
const controllers = new Map(); // jobId → { pause, resume, cancel, stop }
let timer = null;
let broadcastTimer = null;

export function registerController(jobId, controller) {
  controllers.set(jobId, controller);
}

export function update(jobId, snapshot) {
  jobs.set(jobId, { ...jobs.get(jobId), ...snapshot, jobId, updatedAt: Date.now() });
  ended.delete(jobId);
  scheduleBroadcast();
  ensureTimer();
}

/** Marks a job finished: shown as final for a few seconds, then removed. */
export function finish(jobId, snapshot = {}) {
  if (!jobs.has(jobId)) return;
  update(jobId, { ...snapshot, final: true, canPause: false });
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job?.final) remove(jobId);
  }, LINGER_MS);
}

export function remove(jobId) {
  if (!jobs.delete(jobId)) return;
  controllers.delete(jobId);
  ended.add(jobId);
  scheduleBroadcast();
  ensureTimer();
}

export function list() {
  return [...jobs.values()];
}

export function dispatch(jobId, action) {
  const controller = controllers.get(jobId);
  if (!controller || typeof controller[action] !== "function") return false;
  controller[action]();
  return true;
}

function publicJob(job) {
  const { updatedAt, ...rest } = job;
  return rest;
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const message = { type: "live", jobs: list().map(publicJob) };
    for (const port of ports) {
      try { port.postMessage(message); } catch { ports.delete(port); }
    }
  }, 100);
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(tick, SERVER_INTERVAL);
  tick();
}

async function tick() {
  if (!jobs.size && !ended.size) {
    clearInterval(timer);
    timer = null;
    return;
  }
  const account = await getAccount();
  if (!account) return;
  try {
    const prefs = await settings();
    const key = await dataKey();
    const encrypt = prefs.encryptHistory && Boolean(key);
    const payload = [];
    for (const job of jobs.values()) {
      if (job.incognito || job.localOnly) continue;
      const { title, site, ...numbers } = job;
      payload.push({
        jobId: job.jobId,
        state: numbers.state,
        method: numbers.method,
        startedAt: numbers.startedAt,
        fraction: numbers.fraction,
        speed: numbers.speed,
        avgSpeed: numbers.avgSpeed,
        received: numbers.received,
        written: numbers.written,
        estimatedBytes: numbers.estimatedBytes,
        eta: numbers.eta,
        mediaDuration: numbers.mediaDuration,
        height: numbers.height,
        live: numbers.live,
        canPause: numbers.canPause,
        paused: numbers.paused,
        errorCode: numbers.errorCode,
        recent: numbers.recent,
        sealed: await seal({ title, site }, { key, encrypt, aad: job.jobId })
      });
    }
    const endedNow = [...ended];
    const { json } = await api("/api/live/push", { method: "POST", body: { jobs: payload, ended: endedNow }, timeout: 8000 });
    endedNow.forEach((jobId) => ended.delete(jobId));
    for (const command of json.commands || []) dispatch(command.jobId, command.action);
  } catch {
    // Offline or not linked: the bridge still works; try again next tick.
  }
}

/**
 * A website tab asks to connect through bridge.js. Only the top frame of the
 * linked Library's origin is accepted; anything else is disconnected without
 * a reply, so other sites can't detect the extension.
 */
export async function acceptBridge(port) {
  const queue = [];
  const early = (message) => queue.push(message);
  port.onMessage.addListener(early);
  const account = await getAccount();
  let origin = "";
  try { origin = new URL(port.sender?.url || "").origin; } catch {}
  const allowed = account && port.sender?.frameId === 0 && (port.sender.origin || origin) === account.server;
  if (!allowed) {
    port.disconnect();
    return null;
  }
  port.onMessage.removeListener(early);
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.postMessage({
    type: "hello",
    deviceId: account.deviceId,
    version: chrome.runtime.getManifest().version,
    email: account.email,
    jobs: list().map(publicJob)
  });
  return { port, queue };
}
