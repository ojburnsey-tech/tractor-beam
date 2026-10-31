import { MediaSession, saveMedia, recordMedia } from "./media.js";
import { saveSubtitles } from "./subtitles.js";
import { filenameFor, filenameWithExtension, formatBytes, formatTime, safeUrl, publicError } from "./shared.js";

const element = (id) => document.getElementById(id);
const sourceForm = element("source-form");
const sourceUrl = element("source-url");
const audioUrl = element("audio-url");
const referrer = element("referrer");
const qualitySelect = element("quality");
const audioSelect = element("audio");
const modeSelect = element("mode");
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

async function message(data) {
  const result = await chrome.runtime.sendMessage(data);
  if (!result?.ok) throw new Error(result?.error || "The extension could not complete this request.");
  return result;
}

function status(text, state = "ready") {
  text = publicError(text);
  statusLine.textContent = text;
  statusLine.className = state === "error" || state === "done" ? state : "";
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
    if (currentGeneration !== generation) return;
    selection = result;
    element("filename").value = filenameWithExtension(element("filename").value, job.url, result.container.extension);
    element("track-summary").textContent = `${result.live ? "Live recording" : formatTime(result.duration)} · ${result.tracks.map((track) => track.codec.toUpperCase()).join(" + ")}${fps ? ` · ${fps.toFixed(1)} fps` : ""} · ${result.container.extension.toUpperCase()}${result.estimatedBytes ? ` · estimated ${formatBytes(result.estimatedBytes)}` : ""}`;
    saveButton.textContent = result.live ? "Choose file and start recording" : "Choose file and download";
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
    const name = await track.getName() || await track.getLanguageCode() || `Audio ${index + 1}`;
    const option = new Option(name, String(index));
    option.selected = track === primary;
    audioSelect.add(option);
  }
  if (!audioTracks.length) audioSelect.add(new Option("No audio found", "0"));
  const previousMode = modeSelect.value;
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
  element("progress").hidden = true;
  element("statistics").textContent = "";
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
    status("Checking the stream's audio and video…", "inspecting");
    session = new MediaSession({
      allowLive: true,
      concurrency: element("concurrency").value,
      prepare: (url) => message({ type: "prepare-host", url, referrer: job.referrer, origin: job.origin }),
      onRetry: (text) => status(text, busy ? "busy" : "inspecting")
    });
    const input = await session.open(job.url, job.kind);
    mainInput = input;
    if (job.audioUrl) externalAudio = await session.open(job.audioUrl);
    videos = await session.videos(input);
    if (!videos.length && !(await input.getAudioTracks()).length) throw new Error("No complete media track was found. Select the master playlist rather than an individual fragment.");
    qualitySelect.replaceChildren();
    for (let index = 0; index < videos.length; index += 1) {
      const track = videos[index];
      const height = await track.getDisplayHeight();
      const codec = await track.getCodec();
      const bitrate = await track.getBitrate();
      qualitySelect.add(new Option(`${height}p · ${(codec || "unknown").toUpperCase()}${bitrate ? ` · ${(bitrate / 1000000).toFixed(1)} Mbps` : ""}`, String(index)));
    }
    if (!videos.length) qualitySelect.add(new Option("Audio only", "0"));
    element("subtitle-controls").hidden = session.subtitles.length === 0;
    element("subtitle").replaceChildren(...session.subtitles.map((track, index) => new Option(`${track.name} · ${track.language}${track.format !== "webvtt" ? " · unavailable format" : ""}`, String(index))));
    element("tracks").hidden = false;
    element("filename").value = job.filename;
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

for (const input of [sourceUrl, audioUrl, referrer]) {
  input.addEventListener("input", () => {
    generation += 1;
    selection = null;
    saveButton.disabled = true;
    element("tracks").hidden = true;
    status("The link changed. Check the stream again before downloading.");
  });
}

saveButton.addEventListener("click", async () => {
  if (!selection || busy || checking) return;
  if (!window.showSaveFilePicker) {
    status("This Chrome version cannot save directly to disk. Update Chrome and try again.", "error");
    return;
  }
  busy = true;
  lock(true);
  let fileChosen = false;
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: filenameWithExtension(element("filename").value, job.url, selection.container.extension),
      startIn: "downloads",
      types: [{ description: `${selection.container.extension.toUpperCase()} media`, accept: { [selection.container.mime]: [`.${selection.container.extension}`] } }]
    });
    fileChosen = true;
    const writable = await handle.createWritable();
    const progressBar = element("progress");
    progressBar.hidden = false;
    progressBar.value = 0;
    status(selection.live ? "Starting the recording…" : "Downloading and joining the selected tracks…", "busy");
    let lastUpdate = 0;
    const started = performance.now();
    const initialBytes = session.network.bytes;
    element("pause").hidden = selection.live;
    element("finish-recording").hidden = !selection.live;
    element("finish-recording").disabled = false;
    element("pause").textContent = "Pause";
    const save = selection.live ? recordMedia : saveMedia;
    const result = await save(session, selection, writable, (progress) => {
      const now = performance.now();
      if (now - lastUpdate < 300 && ["downloading", "recording"].includes(progress.phase)) return;
      lastUpdate = now;
      const fraction = Math.min(progress.fraction, 0.999);
      progressBar.value = fraction;
      const text = session.paused ? "Paused. Resume to continue this download." : progress.phase === "recording" ? `Recording · ${formatTime(progress.duration)}` : progress.phase === "verifying" ? "Checking that the selected tracks reached the end…" : progress.phase === "finishing" ? "Finishing the media file…" : `Downloading selected tracks · ${(fraction * 100).toFixed(1)}%`;
      status(text, session.paused ? "paused" : selection.live ? "recording" : "busy");
      const speed = (progress.received - initialBytes) / Math.max((now - started) / 1000, 1);
      const eta = !selection.live && progress.fraction > 0.01 && !session.paused ? (now - started) / 1000 * (1 - progress.fraction) / progress.fraction : null;
      element("statistics").textContent = `${formatBytes(progress.written)} written · ${formatBytes(Math.max(0, speed))}/s · ${session.network.completed.size} segment requests completed${eta !== null ? ` · about ${formatTime(eta)} remaining` : ""}${selection.estimatedBytes ? ` · estimated ${formatBytes(selection.estimatedBytes)} total` : ""}`;
    });
    progressBar.value = 1;
    status(result.partial ? `Saved the captured recording to ${handle.name}. It stopped early: ${result.error}` : `Saved ${handle.name} with the selected tracks.`, "done");
    element("statistics").textContent = `${formatBytes(result.written)} · ${formatTime(result.duration)}`;
    selection = null;
  } catch (error) {
    if (!fileChosen && error.name === "AbortError") {
      status("No file chosen. Select a file when you are ready.");
    } else {
      const cancelled = session?.controller.signal.aborted;
      status(cancelled ? "Download cancelled. Check the stream again to restart." : `${error.message} Check the stream again to retry.`, cancelled ? "cancelled" : "error");
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

window.addEventListener("beforeunload", (event) => {
  if (busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});

const id = new URL(location.href).searchParams.get("id");
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
}
