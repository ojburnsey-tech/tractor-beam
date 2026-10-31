// The detail sheet for one download: what it was, how fast it went, and what
// to do if it failed.

import { h } from "../dom.js";
import { icon, kindIcon } from "../icons.js";
import { state, deleteEntry, deviceName } from "../store.js";
import { openSheet } from "../ui/sheet.js";
import { confirmDialog } from "../ui/dialog.js";
import { toast } from "../ui/controls.js";
import { chartCard, speedChart, dataTable } from "../charts.js";
import { entryTitle, qualityText } from "../entries.js";
import { formatSize, formatSpeed, formatClock, formatDurationWords, kindLabel, stateLabel } from "/shared/format.js";
import { explain } from "/shared/explain.js";

function fact(label, value) {
  if (value === null || value === undefined || value === "") return null;
  return h("div", { class: "row fact" }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, label)), h("div", { class: "row-value tabular" }, value));
}

function dateTime(timestamp) {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function codecName(codecs) {
  if (!codecs) return null;
  const names = { avc: "H.264", hevc: "HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1", aac: "AAC", opus: "Opus", mp3: "MP3", vorbis: "Vorbis", flac: "FLAC", ac3: "Dolby Digital", eac3: "Dolby Digital Plus" };
  return codecs.split("+").map((codec) => names[codec] || codec.toUpperCase()).join(" + ");
}

export function openDetail(entry, { onClose }) {
  const tile = h("div", { class: "tile large" }, icon(kindIcon(entry)));
  const title = h("div", { class: "detail-heading" },
    tile,
    h("div", { class: "detail-heading-text" },
      h("h2", { class: "title-3", id: "sheet-title" }, entryTitle(entry)),
      h("p", { class: "subheadline secondary" }, [entry.site, dateTime(entry.finishedAt)].filter(Boolean).join(" · "))));

  const content = [];

  if (entry.unreadable) {
    content.push(h("div", { class: "notice warning" }, icon("lock"), h("div", {},
      h("p", { class: "notice-title" }, "This download can't be read"),
      h("p", { class: "footnote" }, "It was encrypted with a key this browser doesn't have, usually because the password was reset. Its numbers are still shown."))));
  } else if (entry.state !== "done") {
    const info = entry.state === "cancelled" ? explain("cancelled") : entry.state === "partial"
      ? { title: "Saved before the stream ended", detail: "The recording stopped early, but everything captured up to then was saved.", fix: entry.errorMessage ? `Reason: ${entry.errorMessage}` : "" }
      : explain(entry.errorCode);
    content.push(h("div", { class: `notice ${entry.state}` }, icon(entry.state === "failed" ? "failed" : entry.state === "partial" ? "warning" : "cancelled"), h("div", {},
      h("p", { class: "notice-title" }, info.title),
      h("p", { class: "footnote" }, info.detail),
      info.fix ? h("p", { class: "subheadline" }, info.fix) : null,
      entry.errorMessage && entry.state === "failed" ? h("p", { class: "caption" }, `Details: ${entry.errorMessage}`) : null)));
  }

  const values = entry.samples?.values || [];
  if (values.some((value) => value !== null && value > 0)) {
    const interval = entry.samples.interval || 1000;
    content.push(chartCard({
      title: "Speed",
      subtitle: `Average ${formatSpeed(entry.avgSpeed)} · Top ${formatSpeed(entry.peakSpeed)}`,
      height: 200,
      draw: (width) => speedChart(width, { values, interval, average: entry.avgSpeed, label: `Download speed over ${formatClock((values.length * interval) / 1000)}` }),
      table: () => dataTable(["Time", "Speed"], values.map((value, index) => [formatClock((index * interval) / 1000), value === null ? "Paused" : formatSpeed(value)]))
    }));
  }

  const pausedMs = entry.elapsedMs && entry.activeMs ? entry.elapsedMs - entry.activeMs : 0;
  const quality = [qualityText(entry), entry.fps ? `${Math.round(entry.fps * 100) / 100} fps` : ""].filter(Boolean).join(" · ");
  content.push(h("section", { class: "section" },
    h("div", { class: "section-header" }, h("h3", { class: "section-title" }, "Details")),
    h("div", { class: "group" },
      fact("Status", stateLabel(entry.state)),
      fact("Size", entry.bytes ? formatSize(entry.bytes) : null),
      fact("Length", entry.mediaDuration ? formatClock(entry.mediaDuration) : null),
      fact("Quality", quality || null),
      fact("Format", [entry.container?.toUpperCase(), entry.method === "original" ? "Original file" : kindLabel(entry.kind)].filter(Boolean).join(" · ")),
      fact("Codecs", codecName(entry.codecs)),
      fact("Time taken", entry.elapsedMs ? `${formatDurationWords(entry.elapsedMs / 1000)}${pausedMs > 5000 ? ` (paused ${formatDurationWords(pausedMs / 1000)})` : ""}` : null),
      fact("Average speed", entry.avgSpeed ? formatSpeed(entry.avgSpeed) : null),
      fact("Top speed", entry.peakSpeed ? formatSpeed(entry.peakSpeed) : null),
      fact("Parallel connections", entry.method === "original" ? null : entry.concurrency ? `${entry.concurrency}${entry.concurrencyAuto ? " · chosen automatically" : ""}` : null),
      fact("Browser", deviceName(entry.deviceId)),
      fact("Started", dateTime(entry.startedAt)),
      fact("File name", entry.filename || null),
      fact("Stored", entry.encrypted === undefined ? null : entry.encrypted ? "Encrypted" : "Not encrypted"))));

  const sheetRef = {};
  const actions = [];
  if (entry.pageUrl) {
    actions.push(h("a", { class: "row action", href: entry.pageUrl, target: "_blank", rel: "noreferrer" }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, "Open Video Page")), h("span", { class: "row-chevron" }, icon("external"))));
    actions.push(h("button", { class: "row action", type: "button", onClick: async () => {
      try {
        await navigator.clipboard.writeText(entry.pageUrl);
        toast("Link copied");
      } catch {
        toast("Couldn't copy the link", { error: true });
      }
    } }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, "Copy Page Link"))));
  }
  actions.push(h("button", { class: "row destructive", type: "button", onClick: async () => {
    const confirmed = await confirmDialog({
      title: "Delete this download?",
      message: "It's removed from your Library on every device. The saved file on your computer isn't touched.",
      confirmLabel: "Delete",
      destructive: true
    });
    if (!confirmed) return;
    try {
      await deleteEntry(entry.id);
      toast("Download deleted");
      sheetRef.sheet.close();
    } catch (error) {
      toast(error.message, { error: true });
    }
  } }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, "Delete from Library"))));
  content.push(h("section", { class: "section" }, h("div", { class: "group" }, actions)));

  sheetRef.sheet = openSheet({ title, label: entryTitle(entry), content, onClose, wide: true });
  return sheetRef.sheet;
}

export function entryExists(id) {
  return state.entriesById.has(id);
}
