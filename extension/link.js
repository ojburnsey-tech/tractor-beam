// Connects this browser to a Library server. The flow is started here, in an
// extension page, so a web page can never point the extension at its own
// server. See docs/ARCHITECTURE.md, "Linking a browser".

import { getAccount, saveLink, normalizeServer, api, ApiError } from "./account.js";
import { createPairingKeys, pairingCode, openKeyFromWeb, exportDataKey, randomId, sha256, toBase64Url } from "./lib/vault.js";

const element = (id) => document.getElementById(id);
const views = ["connect", "waiting", "connected"];
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
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-Math.round(seconds / 60), "minute");
}

async function renderConnected() {
  const account = await getAccount();
  if (!account) return renderConnect();
  show("connected");
  element("connected-detail").textContent = "Downloads from this browser are saved to your Library.";
  element("summary-server").textContent = account.server.replace(/^https?:\/\//, "");
  element("summary-email").textContent = account.email;
  element("summary-name").textContent = account.name;
  element("summary-sync").textContent = relative(account.lastSync);
  element("sync-error").textContent = account.status !== "ok" ? account.message : "";
  element("open-library").href = `${account.server}/library`;
}

async function renderConnect(message = "") {
  show("connect");
  const stored = await chrome.storage.local.get(["lastServer", "disconnected"]);
  const fromQuery = new URL(location.href).searchParams.get("server");
  // Set when the extension was downloaded from a Library (see server/routes/extension.js).
  const preset = await fetch(chrome.runtime.getURL("config.json")).then((response) => response.json()).then((config) => config.server || "").catch(() => "");
  element("local-hint").hidden = Boolean(preset);
  if (!element("server").value) element("server").value = fromQuery || preset || stored.lastServer || "http://localhost:4321";
  if (!element("name").value) element("name").value = defaultName();
  element("connect-error").textContent = message || (stored.disconnected?.reason === "revoked" ? "This browser was disconnected from your Library. Connect it again to keep syncing." : "");
}

async function connect(event) {
  event.preventDefault();
  const button = element("connect-button");
  element("connect-error").textContent = "";
  let server;
  try {
    server = normalizeServer(element("server").value);
  } catch (error) {
    element("connect-error").textContent = error.message;
    return;
  }
  const name = element("name").value.trim() || defaultName();
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    // Check this really is a Library before registering.
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
    if (error.name !== "AbortError") renderConnect(error.message);
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

element("connect-form").addEventListener("submit", connect);
element("cancel").addEventListener("click", () => {
  polling?.abort();
  renderConnect();
});
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

if (await getAccount()) renderConnected();
else renderConnect();
