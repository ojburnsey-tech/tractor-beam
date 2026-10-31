import { MediaSession, saveMedia, recordMedia } from "./media.js";
import { saveSubtitles } from "./subtitles.js";
import { filenameFor, filenameWithExtension, formatTime, safeUrl, publicError, mediaKind } from "./shared.js";
import { SpeedRecorder } from "./recorder.js";
import { drawSpeedGraph } from "./graph.js";
import { classifyError, explain } from "./lib/explain.js";
import { renderFilename } from "./lib/template.js";
import { siteOf } from "./lib/privacy.js";
import { formatSize, formatSpeed, formatRemaining, formatClock, qualityLabel } from "./lib/format.js";

const element = (id) => document.getElementById(id);
const sourceForm = element("source-form");
const sourceUrl = element("source-url");
const audioUrl = element("audio-url");
const referrer = element("referrer");
const qualitySelect = element("quality");
const audioSelect = element("audio");
const modeSelect = element("mode");
const concurrencySelect = element("concurrency");
const saveButton = element("save");
const cancelButton = element("cancel");
const statusLine = element("status");
let job;
let session;
let videos = [];
let audioTracks = [];
let externalAudio;
let mainInput;
let subtitleSession;
let selection;
let busy = false;
let checking = false;
let generation = 0;

// Library integration state.
let context = null;          // preferences, smart concurrency, page details
let detectedKind = null;     // hls / dash / mp4 … as actually opened
let filenameEdited = false;  // the person typed their own name: leave it alone
let concurrencyTouched = false;
let qualityPreset = false;
let recorder = null;

async function message(data) {
  const result = await chrome.runtime.sendMessage(data);
  if (!result?.ok) throw new Error(result?.error || "The extension could not complete this request.");
  return result;
}

function status(text, state = "ready") {
  text = publicError(text);
  const help = element("status-help");
  const detail = element("status-detail");
  if (state === "error") {
    const code = classifyError(text, { protected: context?.protected });
    const info = explain(code);
    statusLine.textContent = code === "unknown" ? text : info.title;
    help.textContent = code === "unknown" ? info.fix : `${info.detail} ${info.fix}`;
    detail.textContent = code === "unknown" ? "" : text;
  } else {
    statusLine.textContent = text;
    help.textContent = "";
    detail.textContent = "";
  }
  statusLine.className = state === "error" || state === "done" ? state : "";
  document.body.dataset.state = state;
  if (job) message({ type: "job-status", id: job.id, text, state }).catch(() => {});
}

function lock(value) {
  for (const control of document.querySelectorAll("input, select, #inspect, #save-subtitles")) control.disabled = value;
  saveButton.disabled = value || !selection;
  cancelButton.hidden = !value;
  const subtitle = session?.subtitles[Number(element("subtitle").value)];
  element("save-subtitles").disabled = value || !subtitle || subtitle.format !== "webvtt" || Boolean(selection?.live);
  if (session?.closed) for (const id of ["quality", "audio", "mode"]) element(id).disabled = true;
}

function pageTitle() {
  return context?.pageTitle || job?.filename?.replace(/\.[a-z0-9]+$/i, "") || "";
}

/** The filename the person's template produces for the current selection. */
function templatedName(height) {
  const template = context?.prefs?.filenameTemplate || "{title}";
  if (template === "{title}") return job.filename;
  return renderFilename(template, {
    title: pageTitle(),
    site: context?.site || "",
    quality: height ? qualityLabel(height) : modeSelect.value === "audio" ? "audio" : "",
    type: detectedKind || ""
  });
}

/** "en" → "English"; "und" (undetermined) and unknown codes → "". */
function languageName(code) {
  if (!code || code === "und") return "";
  try {
    return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

/** Index of the quality option that matches the person's default. */
function preferredQuality(heights, preference) {
  if (!heights.length || preference === "highest") return 0;
  if (preference === "lowest") return heights.length - 1;
  const target = Number(preference);
  const index = heights.findIndex((height) => height <= target);
  return index >= 0 ? index : heights.length - 1;
}

function applyConcurrency() {
  const recommendation = context?.recommendation;
  const auto = concurrencySelect.querySelector('option[value="auto"]');
  if (recommendation) auto.textContent = `Automatic · ${recommendation.level}`;
  if (!concurrencyTouched && context?.prefs) {
    concurrencySelect.value = context.prefs.concurrency === "auto" ? "auto" : String(context.prefs.concurrency);
  }
  element("concurrency-hint").textContent = concurrencySelect.value === "auto" && recommendation ? recommendation.reason : "";
  return concurrencySelect.value === "auto" ? recommendation?.level || 3 : Number(concurrencySelect.value);
}

async function updateSelection() {
  const currentGeneration = ++generation;
  selection = null;
  saveButton.disabled = true;
  const video = videos[Number(qualitySelect.value)];
  const audio = audioTracks[Number(audioSelect.value)];
  try {
    const result = await session.inspect(video, audio, { audioOnly: modeSelect.value === "audio", videoOnly: modeSelect.value === "video" });
    if (currentGeneration !== generation) return;
    const rates = await Promise.all(result.tracks.map((detail) => detail.track.getBitrate()));
    result.estimatedBytes = result.live ? null : rates.every(Boolean) ? rates.reduce((sum, rate) => sum + rate, 0) * result.duration / 8 : null;
    const fps = video && !result.live && modeSelect.value !== "audio" ? (await video.computeFrameRateMetrics({ targetPacketCount: 30 }).catch(() => ({ bestGuessFrameRate: null }))).bestGuessFrameRate : null;
    const height = video && modeSelect.value !== "audio" ? await video.getDisplayHeight() : null;
    if (currentGeneration !== generation) return;
    result.fps = fps;
    result.height = height;
    selection = result;
    const base = filenameEdited ? element("filename").value : templatedName(height);
    element("filename").value = filenameWithExtension(base, job.url, result.container.extension);
    element("track-summary").textContent = `${result.live ? "Live recording" : formatTime(result.duration)} · ${result.tracks.map((track) => track.codec.toUpperCase()).join(" + ")}${fps ? ` · ${fps.toFixed(1)} fps` : ""} · ${result.container.extension.toUpperCase()}${result.estimatedBytes ? ` · about ${formatSize(result.estimatedBytes)}` : ""}`;
    saveButton.textContent = result.live ? "Choose File and Record" : "Choose File and Download";
    status(result.live ? "Live stream ready. Recording includes the available window and future segments; older segments may be unavailable." : "The selected tracks are ready. Choose where to save the complete file.");
    saveButton.disabled = busy || checking;
  } catch (error) {
    if (currentGeneration !== generation) return;
    selection = null;
    element("track-summary").textContent = "";
    status(error.message, "error");
  }
}

async function updateAudio() {
  selection = null;
  saveButton.disabled = true;
  const video = videos[Number(qualitySelect.value)];
  audioTracks = video ? await session.audio(video, externalAudio) : await (externalAudio || mainInput).getAudioTracks();
  audioSelect.replaceChildren();
  const primary = externalAudio ? await externalAudio.getPrimaryAudioTrack() : video ? await video.getPrimaryPairableAudioTrack() : await mainInput.getPrimaryAudioTrack();
  for (let index = 0; index < audioTracks.length; index += 1) {
    const track = audioTracks[index];
    const name = await track.getName() || languageName(await track.getLanguageCode()) || `Audio ${index + 1}`;
    const option = new Option(name, String(index));
    option.selected = track === primary;
    audioSelect.add(option);
  }
  if (!audioTracks.length) audioSelect.add(new Option("No audio found", "0"));
  const previousMode = modeSelect.value || context?.prefs?.mode || "both";
  modeSelect.replaceChildren();
  if (video && audioTracks.length) modeSelect.add(new Option("Video with audio", "both"));
  if (video) modeSelect.add(new Option("Video only", "video"));
  if (audioTracks.length) modeSelect.add(new Option("Audio only", "audio"));
  if (Array.from(modeSelect.options).some((option) => option.value === previousMode)) modeSelect.value = previousMode;
  await updateSelection();
}

async function checkStream(event) {
  event?.preventDefault();
  if (busy || checking) return;
  checking = true;
  selection = null;
  session?.stop();
  externalAudio = null;
  element("tracks").hidden = true;
  element("progress-area").hidden = true;
  lock(true);
  try {
    const url = safeUrl(sourceUrl.value.trim());
    const kind = job?.url === url ? job.kind : null;
    const origin = job?.url === url ? job.origin : "";
    const result = await message({
      type: "register-download",
      id: job?.id,
      url,
      audioUrl: audioUrl.value.trim(),
      referrer: referrer.value.trim(),
      origin,
      kind,
      sourceTabId: job?.sourceTabId,
      filename: element("filename").value === "video.mp4" ? filenameFor("", url) : element("filename").value
    });
    job = result.job;
    history.replaceState(null, "", `download.html?id=${job.id}`);
    context = await message({ type: "download-context", id: job.id }).catch(() => null);
    const concurrency = applyConcurrency();
    status("Checking the stream's audio and video…", "inspecting");
    session = new MediaSession({
      allowLive: true,
      concurrency,
      prepare: (url) => message({ type: "prepare-host", url, referrer: job.referrer, origin: job.origin }),
      onRetry: (text) => status(text, busy ? "busy" : "inspecting")
    });
    session.concurrencyUsed = concurrency;
    session.concurrencyAuto = concurrencySelect.value === "auto";
    const input = await session.open(job.url, job.kind);
    detectedKind = ["hls", "dash", "mp4", "webm", "mkv", "mov", "audio"].includes(job.kind) ? job.kind
      : session.playlistUrls.size ? "hls" : session.virtual.size ? "dash" : mediaKind(job.url) || "mp4";
    mainInput = input;
    if (job.audioUrl) externalAudio = await session.open(job.audioUrl);
    videos = await session.videos(input);
    if (!videos.length && !(await input.getAudioTracks()).length) throw new Error("No complete media track was found. Select the master playlist rather than an individual fragment.");
    qualitySelect.replaceChildren();
    const heights = [];
    for (let index = 0; index < videos.length; index += 1) {
      const track = videos[index];
      const height = await track.getDisplayHeight();
      const codec = await track.getCodec();
      const bitrate = await track.getBitrate();
      heights.push(height);
      qualitySelect.add(new Option(`${height}p · ${(codec || "unknown").toUpperCase()}${bitrate ? ` · ${(bitrate / 1000000).toFixed(1)} Mbps` : ""}`, String(index)));
    }
    if (!videos.length) qualitySelect.add(new Option("Audio only", "0"));
    if (!qualityPreset && heights.length) qualitySelect.value = String(preferredQuality(heights, context?.prefs?.quality || "highest"));
    qualityPreset = true;
    element("subtitle-controls").hidden = session.subtitles.length === 0;
    element("subtitle").replaceChildren(...session.subtitles.map((track, index) => new Option(`${track.name} · ${track.language}${track.format !== "webvtt" ? " · unavailable format" : ""}`, String(index))));
    element("tracks").hidden = false;
    if (!filenameEdited) element("filename").value = job.filename;
    await updateAudio();
  } catch (error) {
    const cancelled = session?.controller.signal.aborted;
    status(cancelled ? "Check cancelled. You can check the stream again." : error.message, cancelled ? "cancelled" : "error");
    session?.stop();
  } finally {
    checking = false;
    lock(false);
  }
}

sourceForm.addEventListener("submit", checkStream);
qualitySelect.addEventListener("change", async () => {
  qualitySelect.disabled = true;
  audioSelect.disabled = true;
  try {
    await updateAudio();
  } catch (error) {
    status(error.message, "error");
  } finally {
    qualitySelect.disabled = false;
    audioSelect.disabled = false;
  }
});
audioSelect.addEventListener("change", updateSelection);
modeSelect.addEventListener("change", updateSelection);
element("filename").addEventListener("input", () => { filenameEdited = true; });
concurrencySelect.addEventListener("change", () => {
  concurrencyTouched = true;
  applyConcurrency();
  if (session && !busy) status("Check the stream again to use the new connection setting.");
});

for (const input of [sourceUrl, audioUrl, referrer]) {
  input.addEventListener("input", () => {
    generation += 1;
    selection = null;
    saveButton.disabled = true;
    element("tracks").hidden = true;
    status("The link changed. Check the stream again before downloading.");
  });
}

// ---------- progress, live reporting and history ----------

function snapshot(state, extra = {}) {
  const chosen = extra.selection || selection;
  const fraction = extra.fraction ?? Number(element("progress").value);
  const speed = recorder?.current() || 0;
  const activeSeconds = (recorder?.activeMs || 0) / 1000;
  const eta = !chosen?.live && fraction > 0.01 && fraction < 1 && !session?.paused ? activeSeconds * (1 - fraction) / fraction : null;
  return {
    state,
    startedAt: extra.startedAt,
    fraction: chosen?.live ? null : fraction,
    speed,
    avgSpeed: recorder?.average() || 0,
    received: recorder?.received || 0,
    written: extra.written || 0,
    estimatedBytes: chosen?.estimatedBytes || null,
    eta,
    mediaDuration: chosen?.live ? extra.duration || 0 : chosen?.duration || null,
    height: chosen?.height || null,
    live: Boolean(chosen?.live),
    canPause: Boolean(chosen && !chosen.live),
    paused: Boolean(session?.paused),
    errorCode: extra.errorCode || null,
    recent: recorder?.recent(90) || [],
    title: pageTitle(),
    site: context?.site || siteOf(job.url),
    filename: extra.filename || ""
  };
}

function renderStatistics(view) {
  const cells = [
    ["Speed", view.paused ? "Paused" : formatSpeed(view.speed)],
    ["Average", formatSpeed(view.avgSpeed)],
    [view.live ? "Recorded" : "Saved", formatSize(view.written)],
    [view.live ? "Length" : "Time left", view.live ? formatClock(view.mediaDuration || 0) : view.eta !== null ? formatRemaining(view.eta).replace(/ left$/, "") : "Estimating…"]
  ];
  element("statistics").replaceChildren(...cells.map(([label, value]) => {
    const cell = document.createElement("div");
    const term = document.createElement("dt");
    const data = document.createElement("dd");
    term.textContent = label;
    data.textContent = value;
    cell.append(term, data);
    return cell;
  }));
  drawSpeedGraph(element("speed-graph"), view.recent);
}

function buildEntry(state, { chosen, startedAt, written, duration, errorText, filename }) {
  const summary = recorder.finish(Date.now(), session.network.bytes);
  let mediaHost = "";
  try { mediaHost = new URL(job.url).hostname; } catch {}
  const errorCode = state === "done" ? null : state === "cancelled" ? "cancelled" : state === "partial" ? classifyError(errorText || "") : classifyError(errorText || "", { protected: context?.protected });
  return {
    id: crypto.randomUUID(),
    startedAt,
    finishedAt: Date.now(),
    state,
    kind: detectedKind || "unknown",
    method: "stream",
    mode: chosen.audio && !chosen.video ? "audio" : chosen.video && !chosen.audio ? "video" : "both",
    live: Boolean(chosen.live),
    bytes: written || 0,
    received: summary.received,
    mediaDuration: Number.isFinite(duration) ? duration : null,
    elapsedMs: summary.elapsedMs,
    activeMs: summary.activeMs,
    avgSpeed: summary.avgSpeed,
    peakSpeed: summary.peakSpeed,
    samples: summary.samples,
    height: chosen.height || null,
    codecs: chosen.tracks.map((track) => track.codec).join("+"),
    container: chosen.container.extension,
    fps: chosen.fps ? Math.round(chosen.fps * 100) / 100 : null,
    concurrency: session.concurrencyUsed,
    concurrencyAuto: Boolean(session.concurrencyAuto),
    errorCode,
    title: pageTitle(),
    site: context?.site || siteOf(job.url),
    pageUrl: context?.pageUrl || "",
    filename: filename || "",
    mediaHost,
    errorMessage: errorText ? publicError(errorText) : ""
  };
}

saveButton.addEventListener("click", async () => {
  if (!selection || busy || checking) return;
  if (!window.showSaveFilePicker) {
    status("This Chrome version cannot save directly to disk. Update Chrome and try again.", "error");
    return;
  }
  busy = true;
  lock(true);
  recorder = null;
  let fileChosen = false;
  let handle;
  let liveTimer;
  const chosen = selection;
  const startedAt = Date.now();
  let written = 0;
  let duration = 0;
  const report = (state, extra = {}) => {
    const view = snapshot(state, { selection: chosen, startedAt, written, duration, filename: handle?.name, ...extra });
    renderStatistics(view);
    message({ type: "job-progress", id: job.id, snapshot: view, final: Boolean(extra.final) }).catch(() => {});
  };
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: filenameWithExtension(element("filename").value, job.url, chosen.container.extension),
      startIn: "downloads",
      types: [{ description: `${chosen.container.extension.toUpperCase()} media`, accept: { [chosen.container.mime]: [`.${chosen.container.extension}`] } }]
    });
    fileChosen = true;
    const writable = await handle.createWritable();
    const progressBar = element("progress");
    element("progress-area").hidden = false;
    progressBar.value = 0;
    status(chosen.live ? "Starting the recording…" : "Downloading and joining the selected tracks…", "busy");
    let lastUpdate = 0;
    recorder = new SpeedRecorder();
    recorder.start(Date.now(), session.network.bytes);
    // Sample on a timer, not on progress events: progress stops while paused
    // or stalled, and those moments must show up in the speed graph.
    liveTimer = setInterval(() => {
      recorder.update(Date.now(), session.network.bytes, session.paused);
      report(session.paused ? "paused" : chosen.live ? "recording" : "busy");
    }, 500);
    element("pause").hidden = chosen.live;
    element("finish-recording").hidden = !chosen.live;
    element("finish-recording").disabled = false;
    element("pause").textContent = "Pause";
    const save = chosen.live ? recordMedia : saveMedia;
    const result = await save(session, chosen, writable, (progress) => {
      written = progress.written;
      if (progress.duration) duration = progress.duration;
      const now = performance.now();
      if (now - lastUpdate < 300 && ["downloading", "recording"].includes(progress.phase)) return;
      lastUpdate = now;
      const fraction = Math.min(progress.fraction, 0.999);
      progressBar.value = fraction;
      const text = session.paused ? "Paused. Resume to continue this download." : progress.phase === "recording" ? `Recording · ${formatTime(progress.duration)}` : progress.phase === "verifying" ? "Checking that the selected tracks reached the end…" : progress.phase === "finishing" ? "Finishing the media file…" : `Downloading selected tracks · ${(fraction * 100).toFixed(1)}%`;
      status(text, session.paused ? "paused" : chosen.live ? "recording" : "busy");
    });
    clearInterval(liveTimer);
    progressBar.value = 1;
    written = result.written;
    const state = result.partial ? "partial" : "done";
    const entry = buildEntry(state, { chosen, startedAt, written: result.written, duration: result.duration, errorText: result.error, filename: handle.name });
    status(result.partial ? `Saved the captured recording to ${handle.name}. It stopped early: ${result.error}` : `Saved ${handle.name} with the selected tracks.`, "done");
    report("done", { final: true, fraction: 1 });
    message({ type: "record-download", id: job.id, entry }).catch(() => {});
    selection = null;
  } catch (error) {
    clearInterval(liveTimer);
    if (!fileChosen && error.name === "AbortError") {
      status("No file chosen. Select a file when you are ready.");
    } else {
      const cancelled = session?.controller.signal.aborted;
      status(cancelled ? "Download cancelled. Check the stream again to restart." : `${error.message} Check the stream again to retry.`, cancelled ? "cancelled" : "error");
      if (fileChosen && recorder) {
        const entry = buildEntry(cancelled ? "cancelled" : "failed", { chosen, startedAt, written, duration, errorText: cancelled ? "Download cancelled." : error.message, filename: handle?.name });
        report(cancelled ? "cancelled" : "error", { final: true, errorCode: entry.errorCode });
        message({ type: "record-download", id: job.id, entry }).catch(() => {});
      }
      selection = null;
      session?.stop();
    }
  } finally {
    busy = false;
    if (session.closed) { videos = []; audioTracks = []; externalAudio = null; mainInput = null; }
    element("pause").hidden = true;
    element("finish-recording").hidden = true;
    lock(false);
    if (!selection || session.closed) message({ type: "release-download" }).catch(() => {});
  }
});

element("subtitle").addEventListener("change", () => lock(busy || checking));

element("save-subtitles").addEventListener("click", async () => {
  const track = session?.subtitles[Number(element("subtitle").value)];
  if (!track || track.format !== "webvtt" || busy || checking) return;
  busy = true;
  lock(true);
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: filenameWithExtension(element("filename").value, job.url, "vtt"), types: [{ description: "WebVTT subtitles", accept: { "text/vtt": [".vtt"] } }] });
    subtitleSession = new MediaSession({ prepare: (url) => message({ type: "prepare-host", url, referrer: job.referrer, origin: job.origin }) });
    await subtitleSession.open(job.url, job.kind);
    const selected = subtitleSession.subtitles.find((item) => item.name === track.name && item.language === track.language) || track;
    const writable = await handle.createWritable();
    const count = await saveSubtitles(subtitleSession, selected, writable, (count) => status(`Joining subtitles · ${count} cues`, "busy"));
    status(`Saved ${handle.name} · ${count} subtitle cues.`, selection ? "ready" : "done");
  } catch (error) {
    status(error.name === "AbortError" ? "Subtitle save cancelled." : error.message, error.name === "AbortError" ? "ready" : "error");
  } finally {
    subtitleSession?.stop();
    subtitleSession = null;
    busy = false;
    lock(false);
  }
});

element("pause").addEventListener("click", () => {
  if (!busy || selection?.live) return;
  session.setPaused(!session.paused);
  element("pause").textContent = session.paused ? "Resume" : "Pause";
  status(session.paused ? "Paused. Current network reads may finish before the download stops." : "Resuming download…", session.paused ? "paused" : "busy");
});

element("finish-recording").addEventListener("click", () => {
  if (!busy || !selection?.live) return;
  session.finishRecording();
  element("finish-recording").disabled = true;
  status("Finishing the recording…", "busy");
});

cancelButton.addEventListener("click", () => {
  cancelButton.disabled = true;
  (subtitleSession || session)?.stop();
  status("Cancelling…", "cancelled");
  cancelButton.disabled = false;
});

// Remote control from the Library (this browser or another device).
chrome.runtime.onMessage.addListener((request) => {
  if (request?.type !== "job-command" || !job || request.id !== job.id || !busy) return;
  const live = Boolean(selection?.live);
  if (request.action === "pause" && !live && !session.paused) element("pause").click();
  else if (request.action === "resume" && !live && session.paused) element("pause").click();
  else if (request.action === "stop" && live) element("finish-recording").click();
  else if (request.action === "cancel") cancelButton.click();
});

window.addEventListener("beforeunload", (event) => {
  if (busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});

const params = new URL(location.href).searchParams;
const id = params.get("id");
const sent = params.get("url");
if (id) {
  const { jobs = {} } = await chrome.storage.session.get("jobs");
  job = jobs[id];
  if (job) {
    sourceUrl.value = job.url;
    audioUrl.value = job.audioUrl || "";
    referrer.value = job.referrer || "";
    element("filename").value = job.filename;
    await checkStream();
  } else status("The saved link has expired. Detect the video again or paste a fresh playlist link.", "error");
} else if (sent) {
  // Opened from a link sent to this computer.
  sourceUrl.value = sent;
  await checkStream();
}
