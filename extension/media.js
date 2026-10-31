import { Input, Output, UrlSource, BufferSource, CustomPathedSource, ALL_FORMATS, Conversion, Mp4OutputFormat, StreamTarget, MkvOutputFormat, WebMOutputFormat, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Logging, LogLevel, desc } from "./vendor/media.js";
import { Network, DownloadError } from "./network.js";
import { prepareHls } from "./hls.js";
import { prepareDash } from "./dash.js";
import { mediaKind, safeUrl, publicError } from "./shared.js";

Logging.level = LogLevel.Silent;

export class MediaSession {
  constructor(options = {}) {
    this.controller = new AbortController();
    this.networkController = new AbortController();
    this.paused = false;
    this.recordingFinished = false;
    this.allowLive = Boolean(options.allowLive);
    this.subtitles = [];
    this.livePlaylists = new Set();
    this.dashManagers = [];
    this.network = new Network({ ...options, signal: this.networkController.signal, gate: () => this.waitWhilePaused() });
    this.inputs = [];
    this.virtual = new Map();
    this.playlistUrls = new Set();
    this.playlistGraph = new Map();
    this.variableSets = new Map();
    this.conversions = [];
    this.closed = false;
  }

  source(url) {
    return new UrlSource(url, {
      requestInit: { credentials: "include", cache: "no-store" },
      maxCacheSize: 8 * 1024 * 1024,
      parallelism: this.network.concurrency,
      fetchFn: this.network.fetch.bind(this.network),
      getRetryDelay: this.network.retryDelay.bind(this.network),
      handleUnhandledError: (error) => { this.network.failure = error; }
    });
  }

  async sniff(url) {
    const response = await this.network.fetch(url, { headers: { Range: "bytes=0-1023" } });
    const reader = response.body.getReader();
    try {
      const { value } = await reader.read();
      const opening = new TextDecoder().decode(value?.subarray(0, 1024)).trimStart();
      if (opening.startsWith("#EXTM3U")) return "hls";
      if (/<(?:[\w-]+:)?MPD[\s>]/i.test(opening)) return "dash";
      if (/^(<!doctype|<html)/i.test(opening)) throw new DownloadError("This is a web page. Paste the video's .m3u8, .mpd or MP4 link.", 400);
      return mediaKind(url, response.headers.get("content-type") || "") || "mp4";
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async open(value, kind) {
    const url = safeUrl(value);
    if (kind === "unknown") kind = null;
    kind ||= mediaKind(url) || await this.sniff(url);
    let root = url;
    let source;
    if (["hls", "dash"].includes(kind)) {
      const response = await this.network.read(url);
      const text = new TextDecoder().decode(response.bytes);
      if (kind === "dash") {
        root = await prepareDash(text, response.url, this.network, this.virtual, { allowLive: this.allowLive, subtitles: this.subtitles });
        if (Array.from(this.virtual.entries()).some(([path, content]) => path.startsWith(new URL(".", root).href) && content.includes("#EXTINF:") && !content.includes("#EXT-X-ENDLIST"))) {
          this.dashManagers.push({ root, url: response.url, refreshed: Date.now(), pending: null });
        }
      }
      else {
        root = response.url;
        const prepared = prepareHls(text, root, this.playlistUrls, this.hlsOptions());
        this.virtual.set(root, prepared);
        this.playlistUrls.add(root);
        if (prepared.includes("#EXTINF:") && !prepared.includes("#EXT-X-ENDLIST")) this.livePlaylists.add(root);
      }
      source = new CustomPathedSource(root, async ({ path }) => {
        const manager = this.dashManagers.find((item) => path.startsWith(new URL(".", item.root).href));
        if (manager && path !== manager.root) {
          if (Date.now() - manager.refreshed > 500) {
            manager.pending ||= (async () => {
              const previousMaster = this.virtual.get(manager.root);
              const response = await this.network.read(manager.url);
              await prepareDash(new TextDecoder().decode(response.bytes), response.url, this.network, this.virtual, { root: manager.root, allowLive: true, subtitles: this.subtitles });
              if (this.virtual.get(manager.root) !== previousMaster) throw new DownloadError("The live DASH track selection changed. Start a new recording.", 400);
              manager.refreshed = Date.now();
            })().finally(() => { manager.pending = null; });
            await manager.pending;
          }
          if (!this.virtual.has(path)) throw new DownloadError("The live DASH representation changed. Start a new recording.", 400);
          return new BufferSource(new TextEncoder().encode(this.virtual.get(path)));
        }
        if (this.virtual.has(path) && !this.livePlaylists.has(path)) return new BufferSource(new TextEncoder().encode(this.virtual.get(path)));
        if (this.playlistUrls.has(path)) {
          if (this.virtual.size > 200) throw new DownloadError("This playlist contains too many nested playlists.", 400);
          const response = await this.network.read(path);
          const text = prepareHls(new TextDecoder().decode(response.bytes), response.url, this.playlistUrls, this.hlsOptions());
          this.virtual.set(path, text);
          if (text.includes("#EXTINF:") && !text.includes("#EXT-X-ENDLIST")) this.livePlaylists.add(path);
          else this.livePlaylists.delete(path);
          return new BufferSource(new TextEncoder().encode(text));
        }
        return this.source(safeUrl(path));
      });
    } else {
      source = this.source(url);
    }
    const input = new Input({ source, formats: ALL_FORMATS, formatOptions: { hls: { offsetTimestampsByDateTime: false } } });
    this.inputs.push(input);
    return input;
  }

  async videos(input) {
    return input.getVideoTracks({
      sortBy: async (track) => [desc(await track.getDisplayHeight()), desc(await track.getBitrate() || 0)]
    });
  }

  async audio(video, externalInput) {
    if (externalInput) return externalInput.getAudioTracks();
    return video.getPairableAudioTracks();
  }

  async inspect(video, audio, options = {}) {
    if (!video && !options.audioOnly) throw new DownloadError("No complete video track was found. Choose the stream's playlist rather than an individual fragment.", 400);
    if (!audio && !options.videoOnly) throw new DownloadError("No audio track was found. Choose the master playlist or add the matching audio link below.", 400);
    const tracks = [options.audioOnly ? null : video, options.videoOnly ? null : audio].filter(Boolean);
    const codecs = await Promise.all(tracks.map((track) => track.getCodec()));
    const candidates = [{ format: new Mp4OutputFormat({ fastStart: false }), extension: options.audioOnly ? "m4a" : "mp4", mime: options.audioOnly ? "audio/mp4" : "video/mp4" },
      { format: new WebMOutputFormat(), extension: "webm", mime: options.audioOnly ? "audio/webm" : "video/webm" },
      { format: new MkvOutputFormat(), extension: "mkv", mime: "video/x-matroska" }];
    const container = candidates.find((item) => {
      const commonMp4 = !["mp4", "m4a"].includes(item.extension) || !codecs.some((codec) => ["vp8", "vorbis"].includes(codec));
      return commonMp4 && codecs.every((codec) => codec && item.format.getSupportedCodecs().includes(codec));
    });
    if (!container) throw new DownloadError("The selected codecs cannot be copied into an available output container.", 400);
    const format = container.format;
    const details = [];
    for (const track of tracks) {
      const live = await track.isLive();
      if (live && !this.allowLive) throw new DownloadError("Select live recording to save this stream.", 400);
      const codec = await track.getCodec();
      if (!codec || !format.getSupportedCodecs().includes(codec)) {
        throw new DownloadError(`The ${track.isVideoTrack() ? "video" : "audio"} codec (${codec || "unknown"}) cannot be copied into MP4.`, 400);
      }
      const config = await track.getDecoderConfig();
      if (!config) throw new DownloadError("A track is missing its playback header. Use the full playlist.", 400);
      const first = await track.getFirstTimestamp();
      const end = await track.getDurationFromMetadata({ skipLiveWait: true }) ?? await track.computeDuration({ skipLiveWait: true });
      if (!Number.isFinite(end) || end - first <= 0) throw new DownloadError("The stream has no complete media duration.", 400);
      details.push({ track, codec, config, first, end, live, duration: end - first });
    }
    const difference = details.length === 2 ? Math.abs(details[0].duration - details[1].duration) : 0;
    if (!details.some((detail) => detail.live) && difference > Math.max(3, Math.min(...details.map((detail) => detail.duration)) * 0.001)) {
      throw new DownloadError("The audio and video have different lengths. Choose their matching full-length playlists.", 400);
    }
    return { video: options.audioOnly ? null : video, audio: options.videoOnly ? null : audio, container, live: details.some((detail) => detail.live), tracks: details, duration: Math.max(...details.map((item) => item.end)) - Math.min(...details.map((item) => item.first)) };
  }

  hlsOptions() {
    return { allowLive: this.allowLive, subtitles: this.subtitles, segmentUrls: this.network.segmentUrls, graph: this.playlistGraph, variableSets: this.variableSets };
  }

  async waitWhilePaused() {
    while (this.paused && !this.controller.signal.aborted) await this.network.wait(100);
    this.controller.signal.throwIfAborted();
  }

  setPaused(value) {
    this.paused = Boolean(value);
  }

  finishRecording() {
    this.recordingFinished = true;
    this.networkController.abort();
  }

  stop() {
    this.controller.abort();
    this.networkController.abort();
    this.conversions.forEach((conversion) => conversion.cancel().catch(() => {}));
    this.dispose();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.networkController.abort();
    this.inputs.forEach((input) => input.dispose());
    this.virtual.clear();
    this.playlistGraph.clear();
    this.variableSets.clear();
    this.livePlaylists.clear();
  }
}

export async function saveMedia(session, selection, writable, onProgress = () => {}) {
  let written = 0;
  let output;
  let committed = false;
  const tracks = [selection.video, selection.audio].filter(Boolean);
  const stream = new WritableStream({
    async write(chunk) {
      session.controller.signal.throwIfAborted();
      await writable.write(chunk);
      written = Math.max(written, chunk.position + chunk.data.byteLength);
    }
  });
  try {
    output = new Output({
      format: selection.container?.format || new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(stream, { chunked: true, chunkSize: 1024 * 1024 })
    });
    const inputs = [...new Set(tracks.map((track) => track.input))];
    const progress = new Map();
    for (const input of inputs) {
      const conversion = await Conversion.init({
        input,
        output,
        tracks: "all",
        video: (track) => ({ discard: track !== selection.video }),
        audio: (track) => ({ discard: track !== selection.audio }),
        copy: { mode: "forced", shiftTolerance: Infinity },
        composable: true
      });
      const required = tracks.filter((track) => track.input === input);
      if (!conversion.isValid || required.some((track) => !conversion.utilizedTracks.includes(track))) {
        throw new DownloadError("The selected tracks could not be copied without losing media. Try a different quality or audio track.", 400);
      }
      progress.set(conversion, 0);
      conversion.onProgress = (value) => {
        progress.set(conversion, value);
        onProgress({ fraction: Math.min(...progress.values()), written, received: session.network.bytes, phase: "downloading" });
      };
      session.conversions.push(conversion);
    }
    await output.start();
    for (let until = 4; ; until += 4) {
      await session.waitWhilePaused();
      session.controller.signal.throwIfAborted();
      if (session.network.failure) throw session.network.failure;
      await Promise.all(session.conversions.map((conversion) => conversion.state === "done" ? undefined : conversion.execute({ until })));
      if (session.conversions.every((conversion) => conversion.state === "done")) break;
    }
    onProgress({ fraction: 1, written, received: session.network.bytes, phase: "verifying" });
    for (const detail of selection.tracks) {
      const actualEnd = await detail.track.computeDuration();
      if (actualEnd + 2 < detail.end) {
        throw new DownloadError("A track ended before the playlist did. The incomplete download has been discarded.", 400);
      }
    }
    if (session.network.failure) throw session.network.failure;
    session.controller.signal.throwIfAborted();
    onProgress({ fraction: 1, written, received: session.network.bytes, phase: "finishing" });
    await output.finalize();
    session.controller.signal.throwIfAborted();
    await writable.close();
    committed = true;
    return { written, duration: selection.duration };
  } finally {
    if (!committed) {
      await Promise.all(session.conversions.map((conversion) => conversion.cancel().catch(() => {})));
      if (output && output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
      await writable.abort().catch(() => {});
    }
    session.dispose();
    session.conversions.length = 0;
    session.inputs.length = 0;
  }
}

export async function recordMedia(session, selection, writable, onProgress = () => {}) {
  let written = 0;
  let duration = 0;
  let committed = false;
  const stream = new WritableStream({
    async write(chunk) {
      session.controller.signal.throwIfAborted();
      await writable.write(chunk);
      written = Math.max(written, chunk.position + chunk.data.byteLength);
    }
  });
  const output = new Output({ format: selection.container.format, target: new StreamTarget(stream, { chunked: true, chunkSize: 1048576 }) });
  const states = [];
  const offset = Math.min(...selection.tracks.map((detail) => detail.first));
  try {
    for (const detail of selection.tracks) {
      const sink = new EncodedPacketSink(detail.track);
      const source = detail.track.isVideoTrack() ? new EncodedVideoPacketSource(detail.codec) : new EncodedAudioPacketSource(detail.codec);
      const metadata = { languageCode: await detail.track.getLanguageCode(), name: await detail.track.getName() || undefined };
      if (detail.track.isVideoTrack()) output.addVideoTrack(source, { ...metadata, rotation: await detail.track.getRotation() });
      else output.addAudioTrack(source, metadata);
      states.push({ detail, sink, source, last: null, packet: null, ended: false, first: true, count: 0 });
    }
    await output.start();
    while (!session.recordingFinished) {
      session.controller.signal.throwIfAborted();
      for (const state of states) {
        if (state.packet || state.ended) continue;
        try {
          state.packet = state.last ? await state.sink.getNextPacket(state.last, { skipLiveWait: true }) : await state.sink.getFirstPacket({ skipLiveWait: true });
          if (!state.packet && !(await state.detail.track.isLive())) state.ended = true;
        } catch (error) {
          if (!session.recordingFinished) throw error;
        }
      }
      if (session.recordingFinished || states.every((state) => state.ended)) break;
      const available = states.filter((state) => state.packet).sort((a, b) => a.packet.timestamp - b.packet.timestamp);
      if (!available.length) {
        try { await session.network.wait(150); } catch (error) { if (!session.recordingFinished) throw error; }
        continue;
      }
      const state = available[0];
      const packet = state.packet;
      if (state.last && packet.sequenceNumber >= 0 && packet.sequenceNumber === state.last.sequenceNumber) {
        throw new DownloadError("The live stream repeated a packet without advancing its sequence.", 400);
      }
      await state.source.add(packet.clone({ timestamp: packet.timestamp - offset }), state.first ? { decoderConfig: state.detail.config } : undefined);
      state.first = false;
      state.count += 1;
      state.last = packet;
      state.packet = null;
      duration = Math.max(duration, packet.timestamp + packet.duration - offset);
      onProgress({ written, received: session.network.bytes, duration, fraction: 0, phase: "recording" });
    }
    if (states.some((state) => state.count === 0)) throw new DownloadError("Recording stopped before every selected track supplied media. Try again.", 400);
    for (const state of states) state.source.close();
    onProgress({ written, received: session.network.bytes, duration, fraction: 1, phase: "finishing" });
    await output.finalize();
    session.controller.signal.throwIfAborted();
    await writable.close();
    committed = true;
    return { written, duration };
  } catch (error) {
    if (session.controller.signal.aborted || states.some((state) => state.count === 0) || output.state !== "started") throw error;
    for (const state of states) state.source.close();
    await output.finalize();
    await writable.close();
    committed = true;
    return { written, duration, partial: true, error: publicError(error) };
  } finally {
    if (!committed) {
      await output.cancel().catch(() => {});
      await writable.abort().catch(() => {});
    }
    session.dispose();
    session.conversions.length = 0;
    session.inputs.length = 0;
  }
}
