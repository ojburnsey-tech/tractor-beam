import { parseDash, stringToMpdXml, XMLSerializer, DOMParser, addSidxSegmentsToPlaylist } from "./vendor/media.js";
import { DownloadError } from "./network.js";
import { attributes as hlsAttributes } from "./hls.js";
import { safeUrl } from "./shared.js";

function quoted(value) {
  return String(value || "").replace(/["\r\n]/g, "");
}

function rangeText(range) {
  if (!range || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.length <= 0 || range.offset < 0) {
    throw new DownloadError("This DASH stream has an invalid byte range.", 400);
  }
  return `${range.length}@${range.offset}`;
}

export function parseSidx(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > bytes.length) break;
    if (type !== "sidx") {
      offset += size;
      continue;
    }
    const version = bytes[offset + 8];
    if (version > 1 || size < (version ? 40 : 32)) break;
    const timescale = view.getUint32(offset + 16);
    const firstOffset = version ? Number(view.getBigUint64(offset + 28)) : view.getUint32(offset + 24);
    const countOffset = offset + (version ? 38 : 30);
    const count = view.getUint16(countOffset);
    if (!timescale || !Number.isSafeInteger(firstOffset) || countOffset + 2 + count * 12 > offset + size) break;
    const references = [];
    for (let i = 0; i < count; i += 1) {
      const position = countOffset + 2 + i * 12;
      const entry = view.getUint32(position);
      if (entry >>> 31) throw new DownloadError("This DASH stream uses a nested segment index, which is not supported.", 400);
      references.push({ referenceType: 0, referencedSize: entry & 0x7fffffff, subsegmentDuration: view.getUint32(position + 4) });
    }
    return { timescale, firstOffset, references, end: offset + size };
  }
  throw new DownloadError("The DASH segment index could not be read.", 400);
}

async function fillIndex(playlist, network) {
  if (!playlist.sidx) return;
  const index = playlist.sidx;
  const range = index.byterange;
  rangeText(range);
  if (range.length > 8388608) throw new DownloadError("The DASH segment index is too large.", 400);
  const url = safeUrl(index.resolvedUri || index.uri);
  const response = await network.read(url, range.length, { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` });
  const contentRange = response.headers.get("content-range") || "";
  if (response.status !== 206 || !contentRange.startsWith(`bytes ${range.offset}-`) || response.bytes.length !== range.length) {
    throw new DownloadError("The server did not return the requested DASH byte range.", 400);
  }
  if (response.bytes[0] === 0x1c && response.bytes[1] === 0x53 && response.bytes[2] === 0xbb && response.bytes[3] === 0x6b) {
    if (!Number.isFinite(index.duration) || index.duration <= 0) throw new DownloadError("The WebM representation has no known duration.", 400);
    playlist.segments = [{ uri: url, resolvedUri: url, duration: index.duration }];
    playlist.sidx = null;
    return;
  }
  const sidx = parseSidx(response.bytes);
  sidx.firstOffset += sidx.end - range.length;
  addSidxSegmentsToPlaylist(playlist, sidx, url);
}

async function playlistText(playlist, network) {
  await fillIndex(playlist, network);
  if (!playlist.segments?.length) throw new DownloadError("This DASH stream has no downloadable segments.", 400);
  if (playlist.contentProtection) throw new DownloadError("This DASH stream uses DRM.", 400);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", ...(playlist.endList === false ? [] : ["#EXT-X-PLAYLIST-TYPE:VOD"]), `#EXT-X-MEDIA-SEQUENCE:${playlist.segments[0].number ?? playlist.mediaSequence ?? 0}`, `#EXT-X-TARGETDURATION:${playlist.segments.reduce((maximum, segment) => Math.max(maximum, Math.ceil(segment.duration)), 1)}`];
  let previousMap = "";
  for (const segment of playlist.segments) {
    if (!Number.isFinite(segment.duration) || segment.duration <= 0) throw new DownloadError("A DASH segment has no valid duration.", 400);
    if (segment.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    if (segment.map) {
      const url = safeUrl(segment.map.resolvedUri || new URL(segment.map.uri, segment.resolvedUri).href);
      const map = `#EXT-X-MAP:URI="${url}"${segment.map.byterange ? `,BYTERANGE="${rangeText(segment.map.byterange)}"` : ""}`;
      if (map !== previousMap) lines.push(map);
      previousMap = map;
    }
    lines.push(`#EXTINF:${segment.duration},`);
    if (segment.byterange) lines.push(`#EXT-X-BYTERANGE:${rangeText(segment.byterange)}`);
    const mediaUrl = safeUrl(segment.resolvedUri || segment.uri);
    network.segmentUrls.add(mediaUrl);
    lines.push(mediaUrl);
  }
  if (playlist.endList !== false) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

async function prepareDashSingle(text, url, network, virtual, options = {}) {
  if (!/<(?:[\w-]+:)?MPD[\s>]/i.test(text)) throw new DownloadError("The link returned a web page instead of a DASH manifest.", 400);
  if (/<(?:[\w-]+:)?ContentProtection[\s/>]/i.test(text)) throw new DownloadError("This DASH stream uses DRM or protected tracks.", 400);
  if (!options.allowLive && /<(?:[\w-]+:)?MPD\b[^>]*\btype\s*=\s*["']dynamic["']/i.test(text)) {
    throw new DownloadError("This is a live DASH stream. A complete on-demand manifest is needed.", 400);
  }
  if ((text.match(/<(?:[\w-]+:)?Period[\s>]/g) || []).length !== 1) {
    throw new DownloadError("This DASH manifest has multiple periods. Use the site's HLS playlist if available.", 400);
  }
  const manifest = parseDash(text, { manifestUri: url });
  const videos = manifest.playlists || [];
  const root = options.root || `https://mp4-grabber.invalid/${crypto.randomUUID()}/master.m3u8`;
  const master = ["#EXTM3U", "#EXT-X-VERSION:7"];
  const groups = manifest.mediaGroups?.AUDIO || {};
  const audioGroups = new Map();
  let audioIndex = 0;
  for (const members of Object.values(groups)) {
    for (const [name, member] of Object.entries(members).sort((a, b) => Number(Boolean(b[1].default)) - Number(Boolean(a[1].default)))) {
      const choices = new Map();
      for (const playlist of member.playlists || []) {
        const codec = playlist.attributes?.CODECS || "mp4a.40.2";
        if (!choices.has(codec) || (playlist.attributes?.BANDWIDTH || 0) > (choices.get(codec).attributes?.BANDWIDTH || 0)) choices.set(codec, playlist);
      }
      for (const [codec, playlist] of choices) {
        if (!audioGroups.has(codec)) audioGroups.set(codec, { id: `audio-${audioGroups.size}`, entries: [] });
        const group = audioGroups.get(codec);
        const child = new URL(`audio-${audioIndex++}.m3u8`, root).href;
        virtual.set(child, await playlistText(playlist, network));
        group.entries.push({ child, codec, name: `${name} (${codec})`, language: member.language || "und", primary: member.default });
      }
    }
  }
  for (const group of audioGroups.values()) {
    group.entries.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
    for (let index = 0; index < group.entries.length; index += 1) {
      const item = group.entries[index];
      master.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${group.id}",NAME="${quoted(item.name)}",LANGUAGE="${quoted(item.language)}",DEFAULT=${index === 0 ? "YES" : "NO"},AUTOSELECT=YES,URI="${item.child}"`);
    }
  }
  for (let index = 0; index < videos.length; index += 1) {
    const playlist = videos[index];
    const child = new URL(`video-${index}.m3u8`, root).href;
    virtual.set(child, await playlistText(playlist, network));
    const attributes = playlist.attributes || {};
    const resolution = attributes.RESOLUTION;
    const choices = audioGroups.size ? Array.from(audioGroups.entries()) : [["", null]];
    for (const [audioCodec, group] of choices) {
      const codecs = [attributes.CODECS, audioCodec].filter(Boolean).join(",");
      let line = `#EXT-X-STREAM-INF:BANDWIDTH=${attributes.BANDWIDTH || 1000000}`;
      if (codecs) line += `,CODECS="${quoted(codecs)}"`;
      if (resolution?.width && resolution?.height) line += `,RESOLUTION=${resolution.width}x${resolution.height}`;
      if (group) line += `,AUDIO="${group.id}"`;
      master.push(line, child);
    }
  }
  if (!videos.length) {
    for (const group of audioGroups.values()) for (const item of group.entries) master.push(`#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="${quoted(item.codec)}"`, item.child);
    if (!audioGroups.size) throw new DownloadError("This DASH manifest has no supported media tracks.", 400);
  }
  const subtitles = manifest.mediaGroups?.SUBTITLES || {};
  let subtitleIndex = 0;
  for (const members of Object.values(subtitles)) {
    for (const [name, member] of Object.entries(members)) {
      const playlist = member.playlists?.[0];
      if (!playlist) continue;
      const codec = playlist.attributes?.CODECS || "";
      const format = /stpp|ttml/i.test(codec) ? "ttml" : /wvtt/i.test(codec) || playlist.sidx || playlist.segments?.some((segment) => segment.map || /\.(m4s|mp4)(\?|$)/.test(segment.resolvedUri || segment.uri)) ? "embedded" : "webvtt";
      const child = new URL(`subtitles-${subtitleIndex++}.m3u8`, root).href;
      if (format === "webvtt") virtual.set(child, await playlistText(playlist, network));
      if (options.subtitles && !options.subtitles.some((item) => item.url === child)) options.subtitles.push({ url: child, name, language: member.language || "und", format });
    }
  }
  virtual.set(root, master.join("\n"));
  return root;
}


function durationSeconds(text) {
  const match = String(text || "").match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  return match ? Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0) : null;
}

function masterEntries(text) {
  const lines = text.split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const info = hlsAttributes(line);
      entries.push({ line, info, url: info.URI, audio: true });
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) entries.push({ line, info: hlsAttributes(line), url: lines[++index], audio: false });
  }
  return entries;
}

function matchingEntry(entries, item) {
  return entries.filter((entry) => entry.audio === item.audio && (item.audio ? entry.info.LANGUAGE === item.info.LANGUAGE && entry.info.NAME === item.info.NAME :
    entry.info.RESOLUTION === item.info.RESOLUTION && (entry.info.CODECS || "").split(",")[0] === (item.info.CODECS || "").split(",")[0]))
    .sort((a, b) => Math.abs(Number(a.info.BANDWIDTH || 0) - Number(item.info.BANDWIDTH || 0)) - Math.abs(Number(b.info.BANDWIDTH || 0) - Number(item.info.BANDWIDTH || 0)))[0];
}

function joinMediaPlaylists(texts) {
  const target = Math.max(...texts.map((text) => Number(text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] || 1)));
  const result = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-PLAYLIST-TYPE:VOD", `#EXT-X-TARGETDURATION:${target}`];
  for (let index = 0; index < texts.length; index += 1) {
    if (index) result.push("#EXT-X-DISCONTINUITY");
    result.push(...texts[index].split("\n").filter((line) => !/^#EXT(M3U|-X-(VERSION|PLAYLIST-TYPE|TARGETDURATION|MEDIA-SEQUENCE|ENDLIST))/.test(line)));
  }
  result.push("#EXT-X-ENDLIST");
  return result.join("\n");
}

export async function prepareDash(text, url, network, virtual, options = {}) {
  if (/<(?:[\w-]+:)?ContentProtection[\s/>]/i.test(text)) throw new DownloadError("This DASH stream uses DRM or protected tracks.", 400);
  const invalid = () => { throw new DownloadError("The DASH manifest contains malformed XML.", 400); };
  const document = new DOMParser({ errorHandler: { warning: invalid, error: invalid, fatalError: invalid } }).parseFromString(text, "application/xml")?.documentElement;
  if (!document || document.localName !== "MPD") throw new DownloadError("The link did not return a DASH manifest.", 400);
  let timelineSegments = 0;
  for (const node of Array.from(document.getElementsByTagNameNS("*", "S"))) {
    const repeat = Number(node.getAttribute("r") || 0);
    if (!Number.isSafeInteger(repeat) || repeat < -1 || repeat > 200000) throw new DownloadError("This DASH timeline exceeds the supported segment count.", 400);
    timelineSegments += Math.max(0, repeat) + 1;
    if (timelineSegments > 500000) throw new DownloadError("The DASH manifest contains too many segments to process safely.", 400);
  }
  for (const node of Array.from(document.getElementsByTagNameNS("*", "SegmentTemplate"))) {
    for (const attribute of ["timescale", "duration"]) {
      if (node.hasAttribute(attribute) && (!Number.isSafeInteger(Number(node.getAttribute(attribute))) || Number(node.getAttribute(attribute)) <= 0)) throw new DownloadError("The DASH manifest contains invalid segment timing.", 400);
    }
  }
  const periods = Array.from(document.getElementsByTagNameNS("*", "Period"));
  if (periods.length <= 1) return prepareDashSingle(text, url, network, virtual, options);
  if (document.getAttribute("type") === "dynamic") throw new DownloadError("Live DASH with changing periods is not supported. Use an HLS stream when available.", 400);
  const total = durationSeconds(document.getAttribute("mediaPresentationDuration"));
  const parts = [];
  let nextStart = 0;
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    const start = durationSeconds(period.getAttribute("start")) ?? nextStart;
    const next = periods[index + 1] ? durationSeconds(periods[index + 1].getAttribute("start")) : total;
    const duration = durationSeconds(period.getAttribute("duration")) ?? (next === null ? null : next - start);
    if (!duration || Math.abs(start - nextStart) > 0.5) throw new DownloadError("This DASH manifest contains period gaps or unknown period lengths.", 400);
    nextStart = start + duration;
    const clone = document.cloneNode(true);
    const clonedPeriods = Array.from(clone.getElementsByTagNameNS("*", "Period"));
    for (let other = 0; other < clonedPeriods.length; other += 1) if (other !== index) clonedPeriods[other].parentNode.removeChild(clonedPeriods[other]);
    const selected = clone.getElementsByTagNameNS("*", "Period")[0];
    selected.setAttribute("start", "PT0S");
    selected.setAttribute("duration", `PT${duration}S`);
    clone.setAttribute("mediaPresentationDuration", `PT${duration}S`);
    const map = new Map();
    const root = await prepareDashSingle(new XMLSerializer().serializeToString(clone), url, network, map);
    parts.push({ map, root, entries: masterEntries(map.get(root)) });
  }
  const root = parts[0].root;
  const master = ["#EXTM3U", "#EXT-X-VERSION:7"];
  let videos = 0;
  for (const item of parts[0].entries) {
    const matches = parts.map((part) => matchingEntry(part.entries, item));
    if (matches.some((entry) => !entry)) continue;
    virtual.set(item.url, joinMediaPlaylists(parts.map((part, index) => part.map.get(matches[index].url))));
    master.push(item.line);
    if (!item.audio) {
      master.push(item.url);
      videos += 1;
    }
  }
  if (!videos) throw new DownloadError("No video codec and resolution is available across every DASH period.", 400);
  virtual.set(root, master.join("\n"));
  return root;
}
