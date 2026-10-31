export function mediaKind(url, contentType = "") {
  let path;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    path = parsed.pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/mpegurl/i.test(contentType) || /\.m3u8$/.test(path)) return "hls";
  if (/dash\+xml/i.test(contentType) || /\.mpd$/.test(path)) return "dash";
  if (/video\/(iso\.segment|mp2t)/i.test(contentType) || /\.(m4s|cmfv|cmfa|ts)$/.test(path)) return "fragment";
  if (/video\/webm/i.test(contentType) || /\.webm$/.test(path)) return "webm";
  if (/video\/(x-matroska|matroska)/i.test(contentType) || /\.mkv$/.test(path)) return "mkv";
  if (/video\/quicktime/i.test(contentType) || /\.mov$/.test(path)) return "mov";
  if (/audio\/(mpeg|aac|flac|ogg|wav|webm)/i.test(contentType) || /\.(mp3|aac|flac|ogg|wav|opus)$/.test(path)) return "audio";
  if (/^(video|audio)\/(mp4|x-m4v)/i.test(contentType) || /\.(mp4|m4v|m4a|mov)$/.test(path)) return "mp4";
  return null;
}

export function safeUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Enter an HTTP or HTTPS video or playlist link.");
  }
  url.hash = "";
  return url.href;
}

export function filenameFor(title, url) {
  let name = title || "";
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    } catch {}
  }
  if (!title && /^[A-Za-z0-9_.-]{48,}$/.test(name)) name = "video";
  name = name.replace(/\.(m3u8|mpd|mp4|m4v|m4a|mov|webm|mkv|mp3|aac|flac|ogg|wav|opus)$/i, "");
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 140);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/i.test(name)) name = "_" + name;
  return `${name || "video"}.mp4`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const time = Math.floor(seconds);
  const hours = Math.floor(time / 3600);
  const minutes = Math.floor(time / 60) % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`;
}

export function filenameWithExtension(title, url, extension) {
  return filenameFor(title, url).replace(/\.mp4$/, "." + extension);
}

export function publicError(error) {
  return String(error?.message || error || "The download failed.").replace(/https?:\/\/[^\s"'<>]+/g, "the media server").slice(0, 450);
}
