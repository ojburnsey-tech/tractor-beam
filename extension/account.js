// The connection between this browser and the Library server.
//
// Non-secret state (server address, email, settings, sync status) lives in
// chrome.storage.local so the popup can render it instantly. The device token
// and the encryption key live in IndexedDB (see store.js).

import { secrets } from "./store.js";
import { importDataKey } from "./lib/vault.js";

const KEY = "account";
export const VERSION = chrome.runtime.getManifest().version;

export const DEFAULT_SETTINGS = {
  encryptHistory: true,
  quality: "highest",
  mode: "both",
  concurrency: "auto",
  filenameTemplate: "{title}",
  neverSync: [],
  notifyFinished: true,
  notifyFailed: true
};

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function getAccount() {
  return (await chrome.storage.local.get(KEY))[KEY] || null;
}

export async function updateAccount(changes) {
  const current = await getAccount();
  if (!current) return null;
  const next = { ...current, ...changes };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function settings() {
  return { ...DEFAULT_SETTINGS, ...(await getAccount())?.settings };
}

let cachedKey = null;
let cachedRaw = null;

export async function dataKey() {
  const raw = await secrets.get("dataKey");
  if (!raw) return null;
  if (raw !== cachedRaw) {
    cachedKey = await importDataKey(raw);
    cachedRaw = raw;
  }
  return cachedKey;
}

export async function saveLink({ server, token, deviceId, email, name, dataKeyRaw }) {
  await secrets.set("token", token);
  await secrets.set("dataKey", dataKeyRaw);
  await chrome.storage.local.set({
    [KEY]: {
      server,
      deviceId,
      email,
      name,
      linkedAt: Date.now(),
      settings: { ...DEFAULT_SETTINGS },
      cursor: 0,
      lastSync: 0,
      status: "ok",
      message: ""
    },
    lastServer: server
  });
}

/**
 * Links this browser to a Library that lives in a claude.ai artifact. There
 * is no token: the artifact page itself is the other end, reached through
 * the bridge while it's open.
 */
export async function saveArtifactLink({ origin, library, deviceId, name, browser }) {
  await secrets.clear();
  cachedKey = null;
  cachedRaw = null;
  await chrome.storage.local.set({
    [KEY]: {
      mode: "artifact",
      origin,
      library: library || "",
      deviceId,
      name,
      browser: browser || "",
      email: "",
      linkedAt: Date.now(),
      settings: { ...DEFAULT_SETTINGS },
      cursor: 0,
      lastSync: 0,
      status: "ok",
      message: ""
    },
    lastLibrary: library || ""
  });
  await chrome.storage.local.remove("disconnected");
}

/** Forgets the connection. `reason` is shown in the popup when not "user". */
export async function clearAccount(reason = "user") {
  await secrets.clear();
  cachedKey = null;
  cachedRaw = null;
  await chrome.storage.local.remove(KEY);
  if (reason !== "user") await chrome.storage.local.set({ disconnected: { reason, at: Date.now() } });
  else await chrome.storage.local.remove("disconnected");
}

/** Normalises what someone typed into a server origin: "localhost:4321" → "http://localhost:4321". */
export function normalizeServer(input) {
  let text = String(input || "").trim();
  if (!text) throw new Error("Enter the address of your Library.");
  if (!/^https?:\/\//i.test(text)) text = (/^(localhost|127\.|\[::1\])/i.test(text) ? "http://" : "https://") + text;
  let url;
  try { url = new URL(text); } catch { throw new Error("That address isn't valid."); }
  if (url.username || url.password) throw new Error("Leave the user name and password out of the address.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) throw new Error("Use an https:// address. Only localhost can use http.");
  return url.origin;
}

/** Calls the server as this device. Disconnects locally if the server revoked us. */
export async function api(path, { method = "GET", body, server: overrideServer, token: overrideToken, timeout = 15000 } = {}) {
  const account = await getAccount();
  const server = overrideServer || account?.server;
  if (!server) throw new ApiError("This browser isn't connected to a Library.", 0, "not-linked");
  const token = overrideToken === undefined ? await secrets.get("token") : overrideToken;
  const headers = { "X-Extension-Version": VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(server + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(timeout)
    });
  } catch {
    throw new ApiError("Can't reach your Library. Check that it's running and the address is right.", 0, "offline");
  }
  let json = null;
  try { json = await response.json(); } catch {}
  if (!response.ok) {
    if (response.status === 401 && json?.code === "device-revoked" && token && !overrideToken) {
      await clearAccount("revoked");
    }
    throw new ApiError(json?.error || `The Library answered with HTTP ${response.status}.`, response.status, json?.code);
  }
  return { status: response.status, json: json || {} };
}
