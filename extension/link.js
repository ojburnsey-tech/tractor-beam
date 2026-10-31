// MP4 Grabber's Library page: connect, approve a Library's pairing request,
// see the connection, export history.
//
// An artifact Library (in Claude) asks to pair from its own page, which
// opens this page with ?pair=<id>; nothing is linked until the person
// approves here. A self-hosted Library is connected from this page, so a
// web page can never point the extension at a server of its choosing.

import { getAccount, saveLink, normalizeServer, api, ApiError } from "./account.js";
import { history } from "./store.js";
import { createPairingKeys, pairingCode, openKeyFromWeb, exportDataKey, randomId, sha256, toBase64Url } from "./lib/vault.js";

const element = (id) => document.getElementById(id);
const views = ["connect", "server", "pair", "waiting", "connected"];
const params = new URL(location.href).searchParams;
let polling = null;

function show(view) {
  for (const name of views) element(name).hidden = name !== view;
}

function defaultName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const system = /mac/i.test(platform) ? "Mac" : /win/i.test(platform) ? "Windows" : /cros/i.test(platform) ? "ChromeOS" : /linux/i.test(platform) ? "Linux" : "this computer";
  return `Chrome on ${system}`;
}

function browserDescription() {
  const brand = navigator.userAgentData?.brands?.find((item) => !/not.a.brand|chromium/i.test(item.brand)) || navigator.userAgentData?.brands?.[0];
  return brand ? `${brand.brand} ${brand.version} · MP4 Grabber ${chrome.runtime.getManifest().version}` : `MP4 Grabber ${chrome.runtime.getManifest().version}`;
}

function relative(timestamp) {
  if (!timestamp) return "Not yet";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), "hour");
  return format.format(-Math.round(seconds / 86400), "day");
}

async function presetConfig() {
  try {
    return await (await fetch(chrome.runtime.getURL("config.json"))).json();
  } catch {
    return {};
  }
}

/** The claude.ai address of the Library, if this browser knows it. */
async function knownLibrary() {
  const [config, stored] = await Promise.all([presetConfig(), chrome.storage.local.get(["lastLibrary"])]);
  return config.library || stored.lastLibrary || "";
}

// ---------- export (the fallback when a Library can't connect) ----------

async function exportHistory() {
  const entries = (await history.all()).filter((entry) => !entry.localOnly).map(({ localOnly, ...entry }) => entry);
  if (!entries.length) {
    alert("There are no downloads to export yet.");
    return;
  }
  const file = { format: "mp4-grabber-history", version: 1, exportedAt: new Date().toISOString(), entries };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
  try {
    await chrome.downloads.download({ url, filename: `mp4-grabber-history-${new Date().toISOString().slice(0, 10)}.json`, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ---------- views ----------

async function renderConnected() {
  const account = await getAccount();
  if (!account) return renderConnect();
  show("connected");
  const artifact = account.mode === "artifact";
  element("connected-detail").textContent = artifact
    ? "Downloads from this browser are saved to your Library whenever it's open in a tab here. Downloads made while it's closed wait and arrive the next time you open it."
    : "Downloads from this browser are saved to your Library.";
  element("summary-server").textContent = artifact ? "In Claude" : account.server.replace(/^https?:\/\//, "");
  element("summary-email-row").hidden = artifact;
  element("summary-email").textContent = account.email || "";
  element("summary-name").textContent = account.name;
  element("summary-sync").textContent = relative(account.lastSync);
  const pending = (await chrome.runtime.sendMessage({ type: "popup-state" }))?.pending || 0;
  element("summary-pending").textContent = pending ? `${pending} download${pending === 1 ? "" : "s"}` : "Nothing";
  element("sync-error").textContent = account.status === "error" || account.status === "offline" ? account.message : "";
  const link = element("open-library");
  const address = artifact ? account.library : `${account.server}/library`;
  link.hidden = !address;
  if (address) link.href = address;
}

async function renderConnect(message = "") {
  show("connect");
  const library = await knownLibrary();
  const open = element("open-library-start");
  open.hidden = !library;
  if (library) open.href = library;
  const stored = await chrome.storage.local.get("disconnected");
  element("connect-error").textContent = message || (stored.disconnected?.reason === "revoked" ? "This browser was disconnected from your Library. Connect it again to keep saving downloads there." : "");
  element("export-start").hidden = (await history.all()).length === 0;
}

async function renderServer(message = "") {
  show("server");
  const stored = await chrome.storage.local.get(["lastServer"]);
  const config = await presetConfig();
  element("local-hint").hidden = Boolean(config.server);
  if (!element("server-address").value) element("server-address").value = params.get("server") || config.server || stored.lastServer || "http://localhost:4321";
  if (!element("name").value) element("name").value = defaultName();
  element("server-error").textContent = message;
}

async function renderPair(id) {
  const result = await chrome.runtime.sendMessage({ type: "pair-info", id });
  if (!result?.info) {
    renderConnect("That connection request has expired. In your Library, choose Connect This Browser again.");
    return;
  }
  show("pair");
  element("pair-code").textContent = result.info.code;
  element("pair-host").textContent = `Requested by ${result.info.library || new URL(result.info.origin).host}`;
  if (!element("pair-name").value) element("pair-name").value = defaultName();
  element("pair-name").focus();
}

// ---------- pairing with an artifact Library ----------

element("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element("pair-confirm");
  button.disabled = true;
  element("pair-error").textContent = "";
  const result = await chrome.runtime.sendMessage({ type: "pair-confirm", id: params.get("pair"), name: element("pair-name").value, browser: browserDescription() });
  button.disabled = false;
  if (!result?.ok) {
    element("pair-error").textContent = result?.error || "The connection couldn't be completed.";
    return;
  }
  window.history.replaceState(null, "", "link.html");
  renderConnected();
});

element("pair-decline").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "pair-decline", id: params.get("pair") });
  window.close();
});

// ---------- connecting to a self-hosted Library ----------

async function connectServer(event) {
  event.preventDefault();
  const button = element("connect-button");
  element("server-error").textContent = "";
  let server;
  try {
    server = normalizeServer(element("server-address").value);
  } catch (error) {
    element("server-error").textContent = error.message;
    return;
  }
  const name = element("name").value.trim() || defaultName();
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const { json: state } = await api("/api/auth/state", { server, token: null });
    if (typeof state.signupOpen !== "boolean") throw new Error("That address doesn't look like an MP4 Grabber Library.");
    const keys = await createPairingKeys();
    const id = randomId(16);
    const secret = randomId(32);
    await api("/api/link/requests", {
      method: "POST",
      server,
      token: null,
      body: { id, secretHash: toBase64Url(await sha256(secret)), publicKey: keys.publicKey, name, browser: browserDescription() }
    });
    const approveUrl = `${server}/link#r=${encodeURIComponent(id)}`;
    element("code").textContent = await pairingCode(keys.publicKey);
    show("waiting");
    const tab = await chrome.tabs.create({ url: approveUrl });
    element("reopen").onclick = () => chrome.tabs.create({ url: approveUrl });
    await waitForApproval({ server, id, secret, keys, name, tabId: tab.id });
  } catch (error) {
    if (error.name !== "AbortError") renderServer(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Continue";
  }
}

async function waitForApproval({ server, id, secret, keys, name, tabId }) {
  const controller = new AbortController();
  polling = controller;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (!controller.signal.aborted) {
    if (Date.now() > deadline) throw new Error("The request expired after 10 minutes. Start again.");
    let result;
    try {
      result = await api(`/api/link/requests/${encodeURIComponent(id)}/claim`, { method: "POST", server, token: null, body: { secret } });
    } catch (error) {
      if (error instanceof ApiError && error.code === "offline") {
        element("waiting-note").textContent = "Can't reach your Library. Retrying…";
        await sleep(3000, controller.signal);
        continue;
      }
      throw error;
    }
    if (result.status === 200 && result.json.status === "approved") {
      const dataKey = await openKeyFromWeb(result.json.wrappedKey, keys.privateKey, keys.publicKey);
      await saveLink({ server, token: result.json.token, deviceId: result.json.deviceId, email: result.json.email, name, dataKeyRaw: await exportDataKey(dataKey) });
      await chrome.runtime.sendMessage({ type: "account-linked" });
      chrome.tabs.update(tabId, { url: `${server}/library` }).catch(() => {});
      await renderConnected();
      return;
    }
    element("waiting-note").textContent = "Waiting for approval…";
    await sleep(1500, controller.signal);
  }
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    }, { once: true });
  });
}

element("connect-form").addEventListener("submit", connectServer);
element("use-server").addEventListener("click", () => renderServer());
element("server-back").addEventListener("click", () => renderConnect());
element("cancel").addEventListener("click", () => {
  polling?.abort();
  renderServer();
});
element("export").addEventListener("click", exportHistory);
element("export-start").addEventListener("click", exportHistory);
element("sync").addEventListener("click", async () => {
  const button = element("sync");
  button.disabled = true;
  button.textContent = "Syncing…";
  await chrome.runtime.sendMessage({ type: "sync-now" });
  button.disabled = false;
  button.textContent = "Sync Now";
  renderConnected();
});
element("disconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect this browser from your Library? Downloads already in your Library stay there.")) return;
  await chrome.runtime.sendMessage({ type: "unlink" });
  renderConnect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.account && !element("connected").hidden) renderConnected();
});

if (params.get("pair")) renderPair(params.get("pair"));
else if (await getAccount()) renderConnected();
else if (params.get("server") || (await presetConfig()).server) renderServer();
else renderConnect();
