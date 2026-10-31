// Talks to the MP4 Grabber extension when it runs in this same browser and is
// linked to this Library. The extension only answers on the linked origin;
// elsewhere it stays silent, so "not connected" is the normal default.

const CHANNEL = "mp4grabber";
export const status = { connected: false, deviceId: null, version: null };
const jobListeners = new Set();
const statusListeners = new Set();
let started = false;
let helloTimer = null;

function post(message) {
  window.postMessage({ channel: CHANNEL, from: "page", ...message }, location.origin);
}

function setConnected(value, details = {}) {
  const changed = status.connected !== value || status.deviceId !== (details.deviceId ?? status.deviceId);
  Object.assign(status, { connected: value, ...details });
  if (changed) statusListeners.forEach((callback) => callback(status));
}

export function start() {
  if (started) return;
  started = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.from !== "extension") return;
    if (data.type === "hello") {
      setConnected(true, { deviceId: data.deviceId, version: data.version });
      jobListeners.forEach((callback) => callback(data.jobs || []));
    } else if (data.type === "live") {
      jobListeners.forEach((callback) => callback(data.jobs || []));
    } else if (data.type === "disconnected") {
      setConnected(false);
    }
  });
  const hello = () => {
    if (!status.connected) post({ type: "hello" });
  };
  hello();
  helloTimer = setInterval(hello, 10000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") hello();
  });
}

export function stop() {
  clearInterval(helloTimer);
}

export function command(jobId, action) {
  post({ type: "command", jobId, action });
}

export function syncNow() {
  post({ type: "sync-now" });
}

export function onJobs(callback) {
  jobListeners.add(callback);
  return () => jobListeners.delete(callback);
}

export function onStatus(callback) {
  statusListeners.add(callback);
  return () => statusListeners.delete(callback);
}
