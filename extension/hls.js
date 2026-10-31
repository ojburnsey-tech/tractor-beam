import { safeUrl } from "./shared.js";
import { DownloadError } from "./network.js";

export function attributes(line) {
  const result = {};
  const text = line.slice(line.indexOf(":") + 1);
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of text.matchAll(pattern)) result[match[1]] = match[2].replace(/^"|"$/g, "");
  return result;
}

export function prepareHls(text, baseUrl, playlistUrls, options = {}) {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new DownloadError("The link returned a web page instead of an HLS playlist.", 400);
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variables = new Map(options.variableSets?.get(baseUrl) || []);
  for (const line of lines.filter((line) => line.startsWith("#EXT-X-DEFINE:"))) {
    const definition = attributes(line);
    if (definition.NAME && definition.VALUE !== undefined) variables.set(definition.NAME, definition.VALUE);
    if (definition.QUERYPARAM) {
      const value = new URL(baseUrl).searchParams.get(definition.QUERYPARAM);
      if (value !== null) variables.set(definition.QUERYPARAM, value);
    }
  }
  const resolve = (value) => {
    for (let count = 0; count < 8 && /\{\$[^}]+\}/.test(value); count += 1) {
      value = value.replace(/\{\$([^}]+)\}/g, (whole, name) => {
        if (!variables.has(name)) throw new DownloadError("The playlist uses an undefined URL variable.", 400);
        return variables.get(name);
      });
    }
    if (/\{\$[^}]+\}/.test(value)) throw new DownloadError("The playlist contains circular URL variables.", 400);
    return safeUrl(new URL(value, baseUrl).href);
  };
  if (!lines.some((line) => line.startsWith("#EXTINF:")) && lines.some((line) => line.startsWith("#EXT-X-PART:"))) {
    throw new DownloadError("This low-latency playlist has only partial segments. Wait for completed segments and check it again.", 400);
  }
  for (const line of lines) {
    if (line.startsWith("#EXTINF:") && (!Number.isFinite(Number(line.slice(8).split(",")[0])) || Number(line.slice(8).split(",")[0]) <= 0)) {
      throw new DownloadError("The playlist contains an invalid segment duration.", 400);
    }
  }
  const media = lines.some((line) => line.startsWith("#EXTINF:"));
  if (media && !lines.includes("#EXT-X-ENDLIST") && (!options.allowLive || lines.includes("#EXT-X-PLAYLIST-TYPE:VOD"))) {
    throw new DownloadError("This is an unfinished or live playlist. A complete on-demand playlist is needed to save the whole video.", 400);
  }
  if (lines.some((line) => line === "#EXT-X-GAP" || line.startsWith("#EXT-X-SKIP:"))) {
    throw new DownloadError("The playlist has missing segments. The whole video cannot be saved from this link.", 400);
  }
  let nextPlaylist = false;
  const children = new Set();
  const result = lines.filter((line) => !line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")).map((line) => {
    if (/^#EXT-X-(SESSION-)?KEY:/.test(line)) {
      const key = attributes(line);
      if (!["NONE", "AES-128"].includes(key.METHOD) || (key.KEYFORMAT && key.KEYFORMAT !== "identity")) {
        throw new DownloadError("This stream uses DRM or an unsupported encryption method.", 400);
      }
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) nextPlaylist = true;
    if (line && !line.startsWith("#")) {
      const url = resolve(line);
      if (nextPlaylist) { playlistUrls.add(url); children.add(url); options.variableSets?.set(url, new Map(variables)); }
      else options.segmentUrls?.add(url);
      nextPlaylist = false;
      return url;
    }
    return line.replace(/URI="([^"]+)"/g, (whole, value) => {
      const url = resolve(value);
      if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(line)) { playlistUrls.add(url); children.add(url); options.variableSets?.set(url, new Map(variables)); }
      if (line.startsWith("#EXT-X-MEDIA:") && attributes(line).TYPE === "SUBTITLES") {
        const info = attributes(line);
        if (options.subtitles && !options.subtitles.some((item) => item.url === url)) {
          options.subtitles.push({ url, name: info.NAME || info.LANGUAGE || "Subtitles", language: info.LANGUAGE || "und", format: "webvtt" });
        }
      }
      return `URI="${url}"`;
    });
  }).join("\n");
  if (options.graph) {
    options.graph.set(baseUrl, children);
    const visited = new Set();
    const active = new Set();
    const visit = (url) => {
      if (active.has(url)) throw new DownloadError("The playlist contains a circular reference.", 400);
      if (visited.has(url)) return;
      active.add(url);
      for (const child of options.graph.get(url) || []) visit(child);
      active.delete(url);
      visited.add(url);
    };
    visit(baseUrl);
  }
  return result;
}
