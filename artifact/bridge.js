// Talks to the MP4 Grabber extension running in this same browser.
//
// The artifact runs in a sandboxed frame inside claude.ai whose origin can
// be opaque ("null"), so messages are addressed with "*" and checked by
// source window only: both sides of the bridge are this same window. The
// extension answers only once this Library has been paired with it, and
// otherwise stays silent.

const CHANNEL = "mp4grabber";
export const status = { connected: false, deviceId: null, version: null, name: "" };
const handlers = new Map();
const jobListeners = new Set();
const statusListeners = new Set();
let started = false;

export function post(message) {
  window.postMessage({ channel: CHANNEL, from: "page", ...message }, "*");
}

function setConnected(value, details = {}) {
  const changed = status.connected !== value || (details.deviceId && status.deviceId !== details.deviceId);
  Object.assign(status, { connected: value, ...details });
  if (changed) statusListeners.forEach((callback) => callback(status));
}

/** Register a handler for one message type from the extension. */
export function onMessage(type, handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(handler);
  return () => handlers.get(type)?.delete(handler);
}

export function start() {
  if (started) return;
  started = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.from !== "extension" || typeof data.type !== "string") return;
    if (data.type === "hello") {
      setConnected(true, { deviceId: data.deviceId, version: data.version, name: data.name || "" });
      jobListeners.forEach((callback) => callback(data.jobs || []));
    } else if (data.type === "live") {
      jobListeners.forEach((callback) => callback(data.jobs || []));
    } else if (data.type === "disconnected") {
      setConnected(false);
    }
    for (const handler of handlers.get(data.type) || []) {
      try { handler(data); } catch (error) { console.error(error); }
    }
  });
  const hello = () => {
    if (!status.connected) post({ type: "hello" });
  };
  hello();
  setInterval(hello, 10000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") hello();
  });
}

export function command(jobId, action) {
  post({ type: "command", jobId, action });
}

export function syncNow() {
  post({ type: "sync-now" });
}

/**
 * Asks the extension to pair with this Library. Resolves with
 * { state: "pending", code } once the extension has opened its
 * confirmation tab, or { state: "missing" } if nothing answered.
 */
export function requestPairing(libraryUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      stopPending();
      stopPaired();
      clearTimeout(timer);
      resolve(value);
    };
    const stopPending = onMessage("pair-pending", (message) => finish({ state: "pending", code: message.code }));
    const stopPaired = onMessage("paired", () => finish({ state: "paired" }));
    const timer = setTimeout(() => finish({ state: "missing" }), 3000);
    post({ type: "pair-request", library: libraryUrl || "" });
  });
}

export function onJobs(callback) {
  jobListeners.add(callback);
  return () => jobListeners.delete(callback);
}

export function onStatus(callback) {
  statusListeners.add(callback);
  return () => statusListeners.delete(callback);
}
