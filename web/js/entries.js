// Presentation helpers for history entries: grouping, labels and filters.
// Pure functions (no DOM) so they can be tested in Node.

import { formatSize, qualityLabel, kindLabel } from "../../shared/format.js";
import { explain } from "../../shared/explain.js";

export function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayLabel(timestamp, now = Date.now(), locale = undefined) {
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(timestamp);
  if (days > 1 && days < 7) return date.toLocaleDateString(locale, { weekday: "long" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
}

/** Entries must already be sorted newest first. */
export function groupByDay(entries, now = Date.now()) {
  const groups = [];
  for (const entry of entries) {
    const key = dayKey(entry.finishedAt || entry.startedAt || 0);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(entry.finishedAt || entry.startedAt || 0, now), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

export function entryTitle(entry) {
  return entry.title || entry.filename?.replace(/\.[a-z0-9]{2,5}$/i, "") || kindLabel(entry.kind);
}

export function qualityText(entry) {
  if (entry.mode === "audio" || entry.kind === "audio") return "Audio";
  return qualityLabel(entry.height);
}

export function entrySubtitle(entry) {
  if (entry.state === "failed" || entry.state === "cancelled") {
    return [entry.site, entry.state === "cancelled" ? "Cancelled" : explain(entry.errorCode).title].filter(Boolean).join(" · ");
  }
  return [entry.site, qualityText(entry), entry.bytes ? formatSize(entry.bytes) : ""].filter(Boolean).join(" · ");
}

export const TYPE_FILTERS = [
  { value: "", label: "All Types" },
  { value: "stream", label: "Streams" },
  { value: "file", label: "Video Files" },
  { value: "audio", label: "Audio" },
  { value: "live", label: "Live Recordings" }
];

export const QUALITY_FILTERS = [
  { value: "", label: "Any Quality" },
  { value: "2160", label: "4K" },
  { value: "1440", label: "1440p" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "sd", label: "Below 720p" }
];

export const STATUS_FILTERS = [
  { value: "", label: "Any Status" },
  { value: "done", label: "Saved" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" }
];

function typeOf(entry) {
  if (entry.live) return "live";
  if (entry.mode === "audio" || entry.kind === "audio") return "audio";
  if (entry.kind === "hls" || entry.kind === "dash") return "stream";
  return "file";
}

function qualityOf(entry) {
  const height = entry.height || 0;
  if (!height) return "";
  if (height >= 2160) return "2160";
  if (height >= 1440) return "1440";
  if (height >= 1080) return "1080";
  if (height >= 720) return "720";
  return "sd";
}

export function filterEntries(entries, { query = "", site = "", type = "", quality = "", status = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (site && entry.site !== site) return false;
    if (type && typeOf(entry) !== type) return false;
    if (quality && qualityOf(entry) !== quality) return false;
    if (status === "done" && !["done", "partial"].includes(entry.state)) return false;
    if (status && status !== "done" && entry.state !== status) return false;
    if (!needle) return true;
    return [entry.title, entry.site, entry.filename].some((value) => value && value.toLowerCase().includes(needle));
  });
}

/** Sites by number of downloads, for the site filter. */
export function sitesOf(entries) {
  const counts = new Map();
  for (const entry of entries) if (entry.site) counts.set(entry.site, (counts.get(entry.site) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([site, count]) => ({ site, count }));
}
