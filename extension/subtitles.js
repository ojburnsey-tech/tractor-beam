import { attributes } from "./hls.js";
import { DownloadError } from "./network.js";
import { safeUrl } from "./shared.js";

function seconds(text) {
  return text.split(":").reduce((value, part) => value * 60 + Number(part), 0);
}

function timestamp(value) {
  const milliseconds = Math.round(Math.max(0, value) * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const secs = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

export async function saveSubtitles(session, track, writable, onProgress = () => {}) {
  let committed = false;
  try {
    if (track.format !== "webvtt") throw new DownloadError("Only WebVTT subtitle tracks can currently be saved. This track uses TTML or embedded subtitles.", 400);
    let text;
    if (session.virtual.has(track.url)) text = session.virtual.get(track.url);
    else text = new TextDecoder().decode((await session.network.read(track.url)).bytes);
    const cues = [];
    const seen = new Set();
    let baseline = null;
    let segmentStart = 0;
    let pendingDuration = 0;
    let byteRange = null;
    let previousRangeEnd = 0;
    const lines = text.trimStart().startsWith("WEBVTT") ? [track.url] : text.split(/\r?\n/).map((line) => line.trim());
    for (const line of lines) {
      if (line.startsWith("#EXTINF:")) pendingDuration = Number(line.slice(8).split(",")[0]);
      if (line.startsWith("#EXT-X-KEY:") && attributes(line).METHOD !== "NONE") throw new DownloadError("Encrypted subtitle tracks are not supported.", 400);
      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        const [length, offset] = line.slice(17).split("@").map(Number);
        byteRange = { length, offset: Number.isFinite(offset) ? offset : previousRangeEnd };
      }
      if (!line || line.startsWith("#")) continue;
      const url = safeUrl(new URL(line, track.url).href);
      const headers = byteRange ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } : {};
      const response = await session.network.read(url, 8388608, headers);
      const body = new TextDecoder().decode(response.bytes).replace(/\r/g, "");
      if (!body.trimStart().startsWith("WEBVTT")) throw new DownloadError("This subtitle track uses a format other than plain WebVTT.", 400);
      const mapping = body.match(/X-TIMESTAMP-MAP\s*=\s*LOCAL:([\d:.]+),MPEGTS:(\d+)/i) || body.match(/X-TIMESTAMP-MAP\s*=\s*MPEGTS:(\d+),LOCAL:([\d:.]+)/i)?.map((value, index, array) => index === 1 ? array[2] : index === 2 ? array[1] : value);
      let offset = 0;
      if (mapping) {
        const mapped = Number(mapping[2]) / 90000 - seconds(mapping[1]);
        baseline ??= mapped - segmentStart;
        offset = mapped - baseline;
      }
      for (const block of body.split(/\n\s*\n/)) {
        const match = block.match(/(?:^|\n)([\d:.]+)\s+-->\s+([\d:.]+)([^\n]*)\n([\s\S]*)/);
        if (!match) continue;
        const start = seconds(match[1]) + offset;
        const end = seconds(match[2]) + offset;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new DownloadError("The subtitle track contains invalid cue times.", 400);
        const key = `${start}:${end}:${match[4]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cues.push({ start, text: `${timestamp(start)} --> ${timestamp(end)}${match[3]}\n${match[4].trim()}` });
      }
      if (byteRange) previousRangeEnd = byteRange.offset + byteRange.length;
      byteRange = null;
      segmentStart += pendingDuration;
      onProgress(cues.length);
    }
    if (!cues.length) throw new DownloadError("No WebVTT cues were found in this subtitle track.", 400);
    cues.sort((a, b) => a.start - b.start);
    await writable.write(`WEBVTT\n\n${cues.map((cue) => cue.text).join("\n\n")}\n`);
    await writable.close();
    committed = true;
    return cues.length;
  } finally {
    if (!committed) await writable.abort().catch(() => {});
  }
}
