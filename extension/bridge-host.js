// The background end of the bridge to the Library page (bridge.js relays).
//
// Accepts a page only if it is the Library this browser is linked to: the
// linked artifact's origin, or, for a self-hosted Library, the server's
// origin in a top-level frame. Anything else gets no reply at all.
//
// Pairing with an artifact Library starts from the page ("Connect This
// Browser"), because an artifact can't be reached from the internet. The
// request only opens MP4 Grabber's own confirmation tab; nothing is linked
// until the person approves it there, after checking the code matches.

import { getAccount, saveArtifactLink } from "./account.js";

const accepted = new Set();
const pending = new Map();      // pairing id → { code, origin, library, port, expires }
const lastRequest = new Map();  // origin → time of the last pairing request
const waiters = new Map();      // batch id → { resolve, reject, timer }
let handlers = {};
let jobsSource = () => [];

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomString(length, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") {
  return [...crypto.getRandomValues(new Uint8Array(length))].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export function setHandlers(next) {
  handlers = next;
}

export function setJobsSource(source) {
  jobsSource = source;
}

function originOf(port) {
  try {
    return new URL(port.sender?.url || "").origin;
  } catch {
    return "";
  }
}

function isLibrary(account, port) {
  if (!account) return false;
  const origin = originOf(port);
  if (!origin || origin === "null") return false;
  if (account.mode === "artifact") return origin === account.origin;
  return port.sender?.frameId === 0 && origin === account.server;
}

function helloFor(account) {
  return {
    type: "hello",
    deviceId: account.deviceId,
    name: account.name || "",
    email: account.email || "",
    mode: account.mode || "server",
    version: chrome.runtime.getManifest().version,
    jobs: jobsSource()
  };
}

export function broadcast(message) {
  for (const port of accepted) {
    try { port.postMessage(message); } catch { accepted.delete(port); }
  }
}

export function libraryConnected() {
  return accepted.size > 0;
}

export function disconnectAll() {
  for (const port of accepted) {
    try { port.disconnect(); } catch {}
  }
  accepted.clear();
}

/** Sends history entries to the open Library; resolves with the ids it saved. */
export function sendEntries(entries, timeout = 30000) {
  const [port] = accepted;
  if (!port) return Promise.reject(new Error("Your Library isn't open."));
  const batch = randomString(12);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(batch);
      reject(new Error("Your Library didn't confirm the saved downloads."));
    }, timeout);
    waiters.set(batch, { resolve, reject, timer });
    try {
      port.postMessage({ type: "entries", batch, entries });
    } catch (error) {
      clearTimeout(timer);
      waiters.delete(batch);
      reject(error);
    }
  });
}

function route(message, port) {
  if (!message || typeof message.type !== "string") return;
  switch (message.type) {
    case "command":
      if (["pause", "resume", "cancel", "stop"].includes(message.action)) handlers.command?.(String(message.jobId), message.action);
      break;
    case "sync-now":
      handlers.syncNow?.();
      break;
    case "ack": {
      const waiter = waiters.get(String(message.batch));
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(String(message.batch));
        waiter.resolve(Array.isArray(message.ids) ? message.ids.map(String) : []);
      }
      break;
    }
    case "settings":
      if (message.settings && typeof message.settings === "object") handlers.settings?.(message.settings);
      break;
    case "inbox":
      if (Array.isArray(message.items)) handlers.inbox?.(message.items.slice(0, 100));
      break;
    case "deleted":
      if (Array.isArray(message.ids)) handlers.deleted?.(message.ids.map(String).slice(0, 5000));
      break;
    case "unlink":
      handlers.unlink?.();
      break;
    case "pair-request":
      // Already linked to this Library: confirm again so it can re-add this browser.
      getAccount().then((account) => {
        if (account?.mode === "artifact" && isLibrary(account, port)) {
          port.postMessage({ type: "paired", deviceId: account.deviceId, name: account.name, browser: account.browser || "", version: chrome.runtime.getManifest().version });
        }
      });
      break;
    default:
      break;
  }
}

function startPairing(port, message) {
  const origin = originOf(port);
  if (!origin || origin === "null" || !/^https?:/.test(origin)) return;
  const now = Date.now();
  for (const [id, item] of pending) {
    if (item.expires < now) pending.delete(id);
    else if (item.origin === origin) {
      // A repeat click: show the same request again rather than a new tab.
      item.port = port;
      port.postMessage({ type: "pair-pending", code: item.code });
      return;
    }
  }
  if (now - (lastRequest.get(origin) || 0) < 15000) return;
  lastRequest.set(origin, now);
  const id = randomString(16);
  const code = `${randomString(3, CODE_ALPHABET)}-${randomString(3, CODE_ALPHABET)}`;
  const library = /^https:\/\/claude\.ai\/[\w/-]+$/.test(String(message.library || "")) ? message.library : "";
  const item = { code, origin, library, expires: now + 10 * 60 * 1000 };
  pending.set(id, { ...item, port });
  // Kept in session storage too: Chrome may restart this worker while the
  // person reads the confirmation tab.
  chrome.storage.session.set({ [`pairing:${id}`]: item }).catch(() => {});
  port.postMessage({ type: "pair-pending", code });
  chrome.tabs.create({ url: chrome.runtime.getURL(`link.html?pair=${id}`) });
}

async function findPairing(id) {
  if (!/^[A-Za-z0-9]{16}$/.test(String(id))) return null;
  let item = pending.get(id);
  if (!item) {
    const stored = (await chrome.storage.session.get(`pairing:${id}`))[`pairing:${id}`];
    if (stored) item = { ...stored, port: null };
  }
  return item && item.expires > Date.now() ? item : null;
}

function forgetPairing(id) {
  pending.delete(id);
  chrome.storage.session.remove(`pairing:${id}`).catch(() => {});
}

export async function pairingInfo(id) {
  const item = await findPairing(id);
  return item ? { code: item.code, origin: item.origin, library: item.library } : null;
}

export async function confirmPairing(id, { name, browser }) {
  const item = await findPairing(id);
  if (!item) throw new Error("This request has expired. In your Library, choose Connect This Browser again.");
  forgetPairing(id);
  const deviceId = randomString(22);
  await saveArtifactLink({ origin: item.origin, library: item.library, deviceId, name, browser });
  const account = await getAccount();
  if (item.port) {
    try {
      item.port.postMessage({ type: "paired", deviceId, name, browser, version: chrome.runtime.getManifest().version });
      item.port.acceptLibrary?.(account);
    } catch {
      // The Library tab was closed; it connects the next time it opens.
    }
  }
  handlers.connected?.();
  return account;
}

export function declinePairing(id) {
  const item = pending.get(id);
  forgetPairing(id);
  try { item?.port?.postMessage({ type: "pair-declined" }); } catch {}
}

export function handleConnect(port) {
  if (port.name !== "web-bridge") return;
  let isAccepted = false;
  const early = [];

  const accept = (account) => {
    if (isAccepted) return;
    isAccepted = true;
    accepted.add(port);
    port.postMessage(helloFor(account));
    early.splice(0).forEach((message) => route(message, port));
    handlers.connected?.();
  };
  port.acceptLibrary = accept;

  port.onMessage.addListener((message) => {
    if (isAccepted) route(message, port);
    else if (message?.type === "pair-request") startPairing(port, message);
    else if (early.length < 20) early.push(message);
  });
  port.onDisconnect.addListener(() => {
    accepted.delete(port);
    for (const item of pending.values()) if (item.port === port) item.port = null;
  });
  getAccount().then((account) => {
    if (isLibrary(account, port)) accept(account);
    // Otherwise stay silent: other sites learn nothing about the extension.
  });
}
