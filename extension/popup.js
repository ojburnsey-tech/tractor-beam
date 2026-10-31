import { startBackdrop } from "./effects.js";
import { filenameFor, formatBytes } from "./shared.js";

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const summary = document.getElementById("summary");
const template = document.getElementById("row");
let currentTab;

function buildRow(video, jobs) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.querySelector(".name").textContent = filenameFor("", video.url);

  const labels = { hls: "HLS stream", dash: "DASH stream", mp4: "MP4 file", webm: "WebM file", mov: "MOV file", mkv: "MKV file", audio: "Audio file", unknown: "Media source", fragment: "Stream fragment" };
  row.querySelector(".meta").textContent = `${labels[video.kind]} · ${new URL(video.url).hostname}${video.size && video.kind === "mp4" ? ` · ${formatBytes(video.size)}` : ""}`;
  const check = row.querySelector(".check");
  check.textContent = video.kind === "fragment" ? "Use its HLS or DASH playlist to download the whole video." : "Check audio, video and duration before saving.";
  check.classList.add(video.kind === "fragment" ? "warn" : "good");
  const button = row.querySelector(".download");
  button.disabled = video.kind === "fragment";
  button.textContent = "Open download";
  const job = Object.values(jobs).reverse().find((item) => item.url === video.url);
  if (job) {
    const status = row.querySelector(".status");
    status.hidden = false;
    status.textContent = job.text;
    status.classList.toggle("error", job.state === "error");
    status.classList.toggle("done", job.state === "done");
    if (job.state === "busy") button.textContent = "View progress";
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
    original.className = "copy";
    original.textContent = "Original file";
    original.addEventListener("click", async () => {
      original.disabled = true;
      const result = await chrome.runtime.sendMessage({ type: "download-original", url: video.url, tabId: currentTab.id });
      if (result?.ok) window.close();
      else { original.textContent = "Try again"; original.disabled = false; }
    });
    row.querySelector(".actions").prepend(original);
  }
  row.querySelector(".copy-link").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(video.url);
      event.target.textContent = "Copied";
    } catch {
      event.target.textContent = "Copy failed";
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
  empty.hidden = visible.length > 0;
  document.body.classList.toggle("has-videos", visible.length > 0);
  const activity = stored[`activity:${currentTab.id}`] || {};
  document.getElementById("activity").textContent = activity.protected ? "This page uses protected media. DRM tracks cannot be saved." : activity.mse ? "Media Source playback detected. Choose an underlying playlist above." : "";
  const jobs = Object.values(stored.jobs || {}).filter((job) => ["busy", "recording", "paused"].includes(job.state));
  const active = document.getElementById("active");
  active.replaceChildren();
  for (const job of jobs) {
    const button = document.createElement("button");
    button.className = "copy active-job";
    button.textContent = `${job.filename} · ${job.text}`;
    button.addEventListener("click", async () => { await chrome.tabs.update(job.downloadTabId, { active: true }); window.close(); });
    active.append(button);
  }
  summary.textContent = visible.length ? `${visible.length} source${visible.length === 1 ? "" : "s"} found` : "Nothing detected yet";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && (changes.jobs || changes[`tab:${currentTab?.id}`] || changes[`activity:${currentTab?.id}`])) refresh();
});

document.getElementById("manual").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "open-download" });
  window.close();
});

[currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
startBackdrop();
await refresh();
