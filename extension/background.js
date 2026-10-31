import { mediaKind, safeUrl, filenameFor, filenameWithExtension } from "./shared.js";

const queues = new Map();
const requests = new Map();
const MAX_VIDEOS = 180;

function serial(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => {});
  return next;
}

function header(headers, name) {
  return headers?.find((item) => item.name.toLowerCase() === name)?.value || "";
}

function pageReferrer(sender) {
  if (/^https?:/.test(sender.url || "")) return sender.url;
  if (/^https?:/.test(sender.origin || "")) return sender.origin + "/";
  return null;
}

function belongsTo(parent, value) {
  if (parent.children?.includes(value)) return true;
  try {
    const candidate = new URL(value);
    if (!/\.(mp4|m4s|ts|cmfv|cmfa)$/i.test(candidate.pathname)) return false;
    const pattern = candidate.origin + candidate.pathname.replace(/\d+/g, "#");
    return parent.children?.some((child) => {
      const source = new URL(child);
      return /\d/.test(source.pathname) && source.origin + source.pathname.replace(/\d+/g, "#") === pattern;
    });
  } catch { return false; }
}

async function badge(tabId, videos) {
  const count = videos.filter((video) => video.kind !== "fragment" && !video.parent).length;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2F9BFF" }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
}

function addVideo(tabId, entry) {
  if (tabId < 0) return Promise.resolve();
  return serial(tabId, async () => {
    const key = `tab:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    const videos = stored[key] || [];
    const existing = videos.find((video) => video.url === entry.url);
    const parent = videos.find((video) => belongsTo(video, entry.url));
    if (parent) {
      entry.parent = parent.url;
      if (entry.kind === "mp4") entry.kind = "fragment";
    }
    if (existing) {
      if (existing.observedReferrer && !entry.observedReferrer) delete entry.referrer;
      Object.assign(existing, Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== null && value !== undefined && value !== "")));
      if (entry.observedReferrer) existing.referrer = entry.referrer || "";
    } else {
      videos.push({ ...entry, firstSeen: Date.now() });
    }
    while (videos.length > MAX_VIDEOS) {
      let index = videos.findIndex((video) => video.kind === "fragment");
      if (index < 0) index = videos.findIndex((video) => !["hls", "dash"].includes(video.kind));
      videos.splice(index >= 0 ? index : 0, 1);
    }
    await chrome.storage.session.set({ [key]: videos });
    await badge(tabId, videos);
  });
}

async function openDownload(message) {
  const url = message.url ? safeUrl(message.url) : "";
  if (!url) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("download.html") });
    return { ok: true };
  }
  const stored = await chrome.storage.session.get([`tab:${message.tabId}`, "jobs"]);
  const video = stored[`tab:${message.tabId}`]?.find((item) => item.url === url);
  if (!video) throw new Error("Reload the video page and detect the stream again.");
  const jobs = stored.jobs || {};
  const existing = Object.values(jobs).find((job) => job.url === url && !["done", "error", "cancelled"].includes(job.state));
  if (existing?.downloadTabId) {
    try {
      await chrome.tabs.update(existing.downloadTabId, { active: true });
      return { ok: true };
    } catch {}
  }
  const sourceTab = await chrome.tabs.get(message.tabId);
  const job = {
    id: crypto.randomUUID(),
    url,
    kind: video.kind,
    sourceTabId: message.tabId,
    referrer: video.observedReferrer ? video.referrer : video.referrer || sourceTab.url,
    origin: video.origin || "",
    filename: filenameFor(sourceTab.title, url),
    state: "ready",
    text: "Ready to inspect the stream."
  };
  await serial("jobs", async () => {
    const { jobs = {} } = await chrome.storage.session.get("jobs");
    jobs[job.id] = job;
    await chrome.storage.session.set({ jobs });
  });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`download.html?id=${job.id}`) });
  await updateJob(job.id, { downloadTabId: tab.id });
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  return { ok: true };
}

function updateJob(id, changes) {
  return serial("jobs", async () => {
    const { jobs = {} } = await chrome.storage.session.get("jobs");
    if (!jobs[id]) return;
    Object.assign(jobs[id], changes);
    const completed = Object.values(jobs).filter((job) => ["done", "error", "cancelled"].includes(job.state));
    for (const job of completed.slice(0, Math.max(0, completed.length - 30))) delete jobs[job.id];
    await chrome.storage.session.set({ jobs });
    if (Object.values(jobs).some((job) => ["busy", "recording", "paused"].includes(job.state))) chrome.power.requestKeepAwake("system");
    else chrome.power.releaseKeepAwake();
  });
}

async function prepareHost(message, sender) {
  if (!sender.tab || !sender.url?.startsWith(chrome.runtime.getURL("download.html"))) {
    throw new Error("Open a download tab first.");
  }
  const url = new URL(safeUrl(message.url));
  const { jobs = {} } = await chrome.storage.session.get("jobs");
  const job = Object.values(jobs).find((item) => item.downloadTabId === sender.tab.id);
  const stored = job?.sourceTabId != null ? await chrome.storage.session.get([`auth:${job.sourceTabId}`, `headers:${job.sourceTabId}`]) : {};
  const context = stored[`auth:${job?.sourceTabId}`] || {};
  const observed = stored[`headers:${job?.sourceTabId}`]?.[url.origin];
  const originalReferrer = observed ? observed.referrer : message.referrer;
  let referrer = originalReferrer ? safeUrl(originalReferrer) : "";
  if (!observed && job?.sourceTabId != null && referrer && new URL(referrer).origin !== url.origin) referrer = new URL(referrer).origin + "/";
  const authorization = context[url.origin];
  const originalOrigin = observed ? observed.origin : message.origin;
  const origin = originalOrigin === "null" ? "null" : /^https?:\/\//.test(originalOrigin || "") ? new URL(originalOrigin).origin : "";
  if (!referrer && !authorization && !origin && !observed) return { ok: true };
  return serial("rules", async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const regexFilter = "^" + url.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/";
    const existing = rules.find((rule) => rule.condition.tabIds?.includes(sender.tab.id) && rule.condition.regexFilter === regexFilter);
    const requestHeaders = referrer ? [{ header: "referer", operation: "set", value: referrer }] : [];
    if (observed && !referrer) requestHeaders.push({ header: "referer", operation: "remove" });
    if (authorization) requestHeaders.push({ header: "authorization", operation: "set", value: authorization });
    for (const [name, value] of Object.entries(observed?.customHeaders || {})) requestHeaders.push({ header: name, operation: "set", value });
    if (origin) requestHeaders.push({ header: "origin", operation: "set", value: origin });
    else if (observed) requestHeaders.push({ header: "origin", operation: "remove" });
    const id = existing?.id || Math.max(0, ...rules.map((rule) => rule.id)) + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing ? [id] : [],
      addRules: [{ id, priority: 1, action: { type: "modifyHeaders", requestHeaders }, condition: {
        regexFilter, tabIds: [sender.tab.id], resourceTypes: ["xmlhttprequest"]
      } }]
    });
    return { ok: true };
  });
}

function clearRules(tabId) {
  return serial("rules", async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = rules.filter((rule) => rule.condition.tabIds?.includes(tabId)).map((rule) => rule.id);
    if (removeRuleIds.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  });
}

async function downloadOriginal(message) {
  const url = safeUrl(message.url);
  const stored = await chrome.storage.session.get(`tab:${message.tabId}`);
  const video = stored[`tab:${message.tabId}`]?.find((item) => item.url === url);
  if (!video || ["hls", "dash", "fragment"].includes(video.kind)) throw new Error("Choose a direct media file first.");
  const pathExtension = new URL(url).pathname.match(/\.(mp4|m4v|m4a|mov|webm|mkv|mp3|aac|flac|ogg|wav|opus)$/i)?.[1];
  const audioExtensions = { "audio/mpeg": "mp3", "audio/aac": "aac", "audio/flac": "flac", "audio/ogg": "ogg", "audio/wav": "wav", "audio/webm": "webm" };
  const extension = pathExtension || audioExtensions[video.mime?.split(";")[0].trim().toLowerCase()] || { webm: "webm", mov: "mov", mkv: "mkv", audio: new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "m4a" }[video.kind] || "mp4";
  const filename = filenameWithExtension("", url, extension);
  let ruleId;
  if (video.referrer) {
    ruleId = await serial("rules", async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      const id = Math.max(0, ...rules.map((rule) => rule.id)) + 1;
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{
        id, priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: video.referrer }] },
        condition: { urlFilter: `|${url}|`, initiatorDomains: [chrome.runtime.id], tabIds: [-1] }
      }] });
      return id;
    });
  }
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: true });
    await chrome.storage.session.set({ [`native:${id}`]: { filename, ruleId } });
    return { ok: true, id };
  } catch (error) {
    if (ruleId) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    throw error;
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!["complete", "interrupted"].includes(delta.state?.current)) return;
  const key = `native:${delta.id}`;
  const stored = (await chrome.storage.session.get(key))[key];
  if (stored?.ruleId) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [stored.ruleId] }).catch(() => {});
  if (stored) await chrome.storage.session.remove(key);
});

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (details.tabId < 0) return;
  requests.set(details.requestId, {
    referrer: header(details.requestHeaders, "referer"),
    origin: header(details.requestHeaders, "origin"),
    authorization: header(details.requestHeaders, "authorization"),
    customHeaders: Object.fromEntries((details.requestHeaders || []).filter((item) => /^x-(auth|access|api|token|csrf|xsrf|playback|session|player|media|video)/i.test(item.name) && item.value).slice(0, 20).map((item) => [item.name.toLowerCase(), item.value]))
  });
  while (requests.size > 600) requests.delete(requests.keys().next().value);
}, { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "object", "other"] }, ["requestHeaders", "extraHeaders"]);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const context = requests.get(details.requestId) || {};
  requests.delete(details.requestId);
  if (details.tabId < 0 || details.statusCode >= 400 || details.initiator === chrome.runtime.getURL("").slice(0, -1)) return;
  const mime = header(details.responseHeaders, "content-type");
  const kind = mediaKind(details.url, mime) || (details.type === "media" ? "unknown" : null);
  if (!kind) return;
  const customHeaders = context.customHeaders || {};
  serial(`headers:${details.tabId}`, async () => {
    const key = `headers:${details.tabId}`;
    const stored = (await chrome.storage.session.get(key))[key] || {};
    const previous = stored[new URL(details.url).origin];
    stored[new URL(details.url).origin] = { referrer: context.referrer || "", origin: context.origin || "", customHeaders: { ...previous?.customHeaders, ...customHeaders } };
    await chrome.storage.session.set({ [key]: stored });
  }).catch(() => {});
  if (context.authorization) {
    const authorization = context.authorization;
    serial(`auth:${details.tabId}`, async () => {
      const key = `auth:${details.tabId}`;
      const stored = await chrome.storage.session.get(key);
      await chrome.storage.session.set({ [key]: { ...stored[key], [new URL(details.url).origin]: authorization } });
    }).catch(() => {});
  }
  delete context.authorization;
  delete context.customHeaders;
  const range = header(details.responseHeaders, "content-range").match(/\/(\d+)$/);
  const size = range ? Number(range[1]) : Number(header(details.responseHeaders, "content-length")) || null;
  addVideo(details.tabId, { url: details.url, kind, size, mime, observedReferrer: true, ...context }).catch(() => {});
}, { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "object", "other"] }, ["responseHeaders"]);

chrome.webRequest.onErrorOccurred.addListener((details) => requests.delete(details.requestId), { urls: ["<all_urls>"] });

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0) return;
  serial(details.tabId, async () => {
    await chrome.storage.session.remove([`tab:${details.tabId}`, `auth:${details.tabId}`, `headers:${details.tabId}`, `activity:${details.tabId}`]);
    await badge(details.tabId, []);
  }).catch(() => {});
}, { urls: ["<all_urls>"], types: ["main_frame"] });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "media-activity" && sender.tab) {
    if (message.activity === "manifest" && ["hls", "dash"].includes(message.kind)) {
      try {
        const url = safeUrl(message.url);
        const children = (message.children || []).filter((value) => { try { safeUrl(value); return value !== url; } catch { return false; } }).slice(0, 300);
        addVideo(sender.tab.id, { url, kind: message.kind, children, referrer: pageReferrer(sender) }).then(() => serial(sender.tab.id, async () => {
          const key = `tab:${sender.tab.id}`;
          const stored = await chrome.storage.session.get(key);
          const videos = stored[key] || [];
          for (const video of videos) if (children.includes(video.url)) video.parent = url;
          await chrome.storage.session.set({ [key]: videos });
          await badge(sender.tab.id, videos);
        })).catch(() => {});
      } catch {}
    } else if (["mse", "protected"].includes(message.activity)) {
      serial(`activity:${sender.tab.id}`, async () => {
        const key = `activity:${sender.tab.id}`;
        const stored = (await chrome.storage.session.get(key))[key] || {};
        stored[message.activity] = true;
        await chrome.storage.session.set({ [key]: stored });
      }).catch(() => {});
    }
    return;
  }
  if (message?.type === "page-videos" && sender.tab) {
    for (const video of (message.videos || []).slice(0, MAX_VIDEOS)) {
      const kind = mediaKind(video.url) || (/^https?:/i.test(video.url) ? "unknown" : null);
      if (kind) addVideo(sender.tab.id, { url: video.url, kind, playing: Boolean(video.playing), referrer: pageReferrer(sender) }).catch(() => {});
    }
    return;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  const task = async () => {
    if (message.type === "download-original") return downloadOriginal(message);
    if (message.type === "open-download") return openDownload(message);
    if (message.type === "register-download" && sender.tab && sender.url.startsWith(chrome.runtime.getURL("download.html"))) {
      const job = {
        id: message.id || crypto.randomUUID(),
        url: safeUrl(message.url),
        audioUrl: message.audioUrl ? safeUrl(message.audioUrl) : "",
        referrer: message.referrer ? safeUrl(message.referrer) : "",
        origin: message.origin || "",
        kind: message.kind || null,
        sourceTabId: message.sourceTabId ?? null,
        filename: filenameFor(message.filename, message.url),
        downloadTabId: sender.tab.id,
        state: "inspecting",
        text: "Checking audio and video…"
      };
      await serial("jobs", async () => {
        const { jobs = {} } = await chrome.storage.session.get("jobs");
        jobs[job.id] = job;
        await chrome.storage.session.set({ jobs });
      });
      await chrome.tabs.update(sender.tab.id, { autoDiscardable: false });
      return { ok: true, job };
    }
    if (message.type === "prepare-host") return prepareHost(message, sender);
    if (message.type === "job-status") {
      const { jobs = {} } = await chrome.storage.session.get("jobs");
      if (jobs[message.id]?.downloadTabId !== sender.tab?.id) throw new Error("This download belongs to a different tab.");
      await updateJob(message.id, { state: message.state, text: String(message.text).slice(0, 500) });
      return { ok: true };
    }
    if (message.type === "release-download" && sender.tab) {
      await clearRules(sender.tab.id);
      return { ok: true };
    }
    return { ok: false, error: "Unknown request." };
  };
  task().then(respond, (error) => respond({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([`tab:${tabId}`, `auth:${tabId}`, `headers:${tabId}`, `activity:${tabId}`]);
  clearRules(tabId).catch(() => {});
  serial("jobs", async () => {
    const { jobs = {} } = await chrome.storage.session.get("jobs");
    for (const job of Object.values(jobs)) {
      if (job.downloadTabId === tabId && !["done", "error", "cancelled"].includes(job.state)) {
        job.state = "cancelled";
        job.text = "The download tab was closed. Start again to save the whole video.";
      }
    }
    await chrome.storage.session.set({ jobs });
    if (!Object.values(jobs).some((job) => ["busy", "paused", "recording"].includes(job.state))) chrome.power.releaseKeepAwake();
  }).catch(() => {});
});
