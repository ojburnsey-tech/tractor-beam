import { filenameFor } from "./shared.js";
import { formatSize, formatSpeed, kindLabel } from "./lib/format.js";

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const summary = document.getElementById("summary");
const template = document.getElementById("row");
let currentTab;
let state = null;

const SVG = "http://www.w3.org/2000/svg";
const GLYPHS = {
  done: "M9 1.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm3.6 5.4-4.3 4.6a.75.75 0 0 1-1.1 0L5.4 9.6a.75.75 0 1 1 1.1-1l1.2 1.3 3.8-4a.75.75 0 0 1 1.1 1Z",
  failed: "M9 1.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 3.75c.41 0 .75.34.75.75v3.5a.75.75 0 0 1-1.5 0V6c0-.41.34-.75.75-.75Zm0 7.9a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z",
  cancelled: "M9 1.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm2.8 9.24a.75.75 0 1 1-1.06 1.06L9 10.06 7.26 11.8a.75.75 0 0 1-1.06-1.06L7.94 9 6.2 7.26A.75.75 0 0 1 7.26 6.2L9 7.94l1.74-1.74a.75.75 0 1 1 1.06 1.06L10.06 9l1.74 1.74Z",
  link: "M9 1.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm3.53 6.47-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V5.25a.75.75 0 0 1 1.5 0v3.38l1.72-1.72a.75.75 0 1 1 1.06 1.06Z"
};
GLYPHS.partial = GLYPHS.done;

function glyph(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("class", `glyph ${name}`);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", GLYPHS[name] || GLYPHS.done);
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  svg.append(path);
  return svg;
}

function textElement(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function relativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 60) return "just now";
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), "hour");
  return format.format(-Math.round(seconds / 86400), "day");
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ---------- detected videos (unchanged behaviour, new look) ----------

function buildRow(video, jobs) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.querySelector(".name").textContent = filenameFor("", video.url);
  const labels = { hls: "HLS stream", dash: "DASH stream", mp4: "MP4 file", webm: "WebM file", mov: "MOV file", mkv: "MKV file", audio: "Audio file", unknown: "Media source", fragment: "Stream fragment" };
  row.querySelector(".meta").textContent = `${labels[video.kind]} · ${new URL(video.url).hostname}${video.size && video.kind === "mp4" ? ` · ${formatSize(video.size)}` : ""}`;
  const check = row.querySelector(".check");
  check.textContent = video.kind === "fragment" ? "A piece of a stream. Use its HLS or DASH playlist to save the whole video." : "";
  check.hidden = video.kind !== "fragment";
  check.classList.toggle("warn", video.kind === "fragment");
  const button = row.querySelector(".download");
  button.disabled = video.kind === "fragment";
  const job = Object.values(jobs).reverse().find((item) => item.url === video.url);
  if (job) {
    const status = row.querySelector(".status");
    status.hidden = false;
    status.textContent = job.text;
    status.classList.toggle("error", job.state === "error");
    status.classList.toggle("done", job.state === "done");
    if (["busy", "paused", "recording"].includes(job.state)) button.textContent = "Show Progress";
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "open-download", url: video.url, tabId: currentTab.id });
      if (!result?.ok) throw new Error(result?.error || "Unable to open the download.");
      window.close();
    } catch (error) {
      const status = row.querySelector(".status");
      status.hidden = false;
      status.textContent = error.message;
      status.classList.add("error");
      button.disabled = false;
    }
  });
  if (!["hls", "dash", "fragment", "unknown"].includes(video.kind)) {
    const original = document.createElement("button");
    original.className = "plain";
    original.type = "button";
    original.textContent = "Original File";
    original.addEventListener("click", async () => {
      original.disabled = true;
      const result = await chrome.runtime.sendMessage({ type: "download-original", url: video.url, tabId: currentTab.id });
      if (result?.ok) window.close();
      else { original.textContent = "Try Again"; original.disabled = false; }
    });
    row.querySelector(".actions").prepend(original);
  }
  row.querySelector(".copy-link").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(video.url);
      event.target.textContent = "Copied";
    } catch {
      event.target.textContent = "Copy Failed";
    }
  });
  return row;
}

async function refresh() {
  if (!currentTab) return;
  const key = `tab:${currentTab.id}`;
  const stored = await chrome.storage.session.get([key, "jobs", `activity:${currentTab.id}`]);
  const videos = stored[key] || [];
  const roots = videos.filter((video) => !video.parent && video.kind !== "fragment");
  const seen = new Set();
  const visible = roots.filter((video) => {
    const key = video.size && !["hls", "dash"].includes(video.kind) ? `${new URL(video.url).origin}:${new URL(video.url).pathname}:${video.size}` : video.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  list.replaceChildren(...visible.map((video) => buildRow(video, stored.jobs || {})));
  list.hidden = visible.length === 0;
  empty.hidden = visible.length > 0;
  const activity = stored[`activity:${currentTab.id}`] || {};
  const notice = document.getElementById("activity");
  notice.textContent = activity.protected ? "This page uses copy-protected (DRM) video, which can't be saved." : activity.mse ? "This player streams in pieces. Choose its HLS or DASH playlist above." : "";
  notice.hidden = !notice.textContent;
  renderActive(Object.values(stored.jobs || {}).filter((job) => ["busy", "recording", "paused"].includes(job.state)));
  summary.textContent = visible.length ? `${visible.length} video${visible.length === 1 ? "" : "s"} on this page` : "Nothing found on this page yet";
}

function renderActive(jobs) {
  const container = document.getElementById("active");
  container.replaceChildren(...jobs.map((job) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row clickable";
    const text = document.createElement("div");
    text.className = "row-text";
    text.append(textElement("p", "row-title", job.filename), textElement("p", "row-meta", job.text));
    row.append(glyph("link"), text);
    row.addEventListener("click", async () => {
      await chrome.tabs.update(job.downloadTabId, { active: true });
      window.close();
    });
    return row;
  }));
  document.getElementById("active-section").hidden = jobs.length === 0;
}

// ---------- account, sent links, recent history ----------

function renderAccount() {
  const button = document.getElementById("account");
  button.hidden = false;
  button.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  const account = state.account;
  button.className = "plain account";
  if (!account) {
    button.classList.add("off");
    label.textContent = state.disconnected?.reason === "revoked" ? "Reconnect Library" : "Connect Library";
    button.title = state.disconnected?.reason === "revoked" ? "This browser was disconnected from your Library." : "Keep a history of your downloads in your Library.";
  } else {
    if (account.status !== "ok") button.classList.add("warn");
    label.textContent = account.status === "offline" ? "Library offline" : account.status === "error" ? "Sync paused" : "Library";
    button.title = account.message || `Connected to ${account.server} as ${account.email}`;
  }
  button.append(dot, label);
  button.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("link.html") });
    window.close();
  };

  const link = document.getElementById("library-link");
  link.hidden = !account;
  if (account) link.href = `${account.server}/library`;
  const sync = document.getElementById("sync-state");
  sync.textContent = account && state.pending ? `${state.pending} waiting to sync` : "";
}

function renderInbox() {
  const container = document.getElementById("inbox");
  container.replaceChildren(...state.inbox.map((item) => {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    text.append(textElement("p", "row-title", item.note || hostOf(item.url) || item.url), textElement("p", "row-meta", `${hostOf(item.url)} · ${relativeTime(item.createdAt)}`));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "primary";
    open.textContent = "Open";
    open.addEventListener("click", async () => {
      open.disabled = true;
      await chrome.runtime.sendMessage({ type: "inbox-open", id: item.id });
      window.close();
    });
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "plain";
    dismiss.textContent = "Remove";
    dismiss.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "inbox-dismiss", id: item.id });
      row.remove();
      document.getElementById("inbox-section").hidden = !container.children.length;
    });
    row.append(glyph("link"), text, dismiss, open);
    return row;
  }));
  document.getElementById("inbox-section").hidden = state.inbox.length === 0;
}

function renderRecent() {
  const container = document.getElementById("recent");
  container.replaceChildren(...state.recent.map((entry) => {
    const linkable = state.account && !entry.localOnly;
    const row = document.createElement(linkable ? "a" : "div");
    row.className = `row${linkable ? " clickable" : ""}`;
    if (linkable) {
      row.href = `${state.account.server}/library/${entry.id}`;
      row.target = "_blank";
      row.rel = "noreferrer";
    }
    const text = document.createElement("div");
    text.className = "row-text";
    const parts = [entry.state === "done" ? formatSize(entry.bytes) : { failed: "Failed", cancelled: "Cancelled", partial: "Saved early" }[entry.state], entry.site, relativeTime(entry.finishedAt)];
    if (entry.state === "done" && entry.avgSpeed) parts.splice(1, 0, formatSpeed(entry.avgSpeed));
    text.append(textElement("p", "row-title", entry.title || entry.filename || kindLabel(entry.kind)), textElement("p", "row-meta", parts.filter(Boolean).join(" · ")));
    row.append(glyph(entry.state), text);
    return row;
  }));
  document.getElementById("recent-section").hidden = state.recent.length === 0;
}

async function loadState() {
  state = await chrome.runtime.sendMessage({ type: "popup-state" });
  if (!state?.ok) return;
  renderAccount();
  renderInbox();
  renderRecent();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && (changes.jobs || changes[`tab:${currentTab?.id}`] || changes[`activity:${currentTab?.id}`])) refresh();
  if (area === "local" && (changes.account || changes.disconnected)) loadState();
});

document.getElementById("manual").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "open-download" });
  window.close();
});

[currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
await Promise.all([refresh(), loadState()]);
