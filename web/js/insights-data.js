// Aggregations behind the Insights page. Pure functions over decrypted
// entries; nothing here touches the DOM or the network.

import { recommendConcurrency } from "../../shared/concurrency.js";

const DAY = 86400000;

export const RANGES = [
  { value: "7d", label: "7 Days", days: 7 },
  { value: "30d", label: "30 Days", days: 30 },
  { value: "90d", label: "90 Days", days: 90 },
  { value: "12m", label: "12 Months", days: 365 },
  { value: "all", label: "All", days: Infinity }
];

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function inRange(entries, range, now = Date.now()) {
  const days = RANGES.find((item) => item.value === range)?.days ?? Infinity;
  if (days === Infinity) return entries;
  const start = startOfDay(now) - (days - 1) * DAY;
  return entries.filter((entry) => (entry.finishedAt || 0) >= start);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const saved = (entry) => entry.state === "done" || entry.state === "partial";

export function summary(entries) {
  const finished = entries.filter(saved);
  const ended = entries.filter((entry) => entry.state !== "cancelled");
  const bytes = finished.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  const mediaSeconds = finished.reduce((sum, entry) => sum + (entry.mediaDuration || 0), 0);
  // Weighted by time: total bytes received ÷ total active seconds.
  const timed = finished.filter((entry) => entry.received > 0 && entry.activeMs > 0);
  const received = timed.reduce((sum, entry) => sum + entry.received, 0);
  const activeSeconds = timed.reduce((sum, entry) => sum + entry.activeMs / 1000, 0);
  return {
    count: entries.length,
    saved: finished.length,
    failed: entries.filter((entry) => entry.state === "failed").length,
    bytes,
    mediaSeconds,
    avgSpeed: activeSeconds ? received / activeSeconds : 0,
    successRate: ended.length ? finished.length / ended.length : null
  };
}

/**
 * Data saved per period: days for short ranges, weeks for 90 days, months
 * beyond that. Empty periods are included so gaps are visible.
 */
export function periods(entries, range, now = Date.now(), locale = undefined) {
  const finished = entries.filter(saved);
  const buckets = [];
  if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    for (let index = days - 1; index >= 0; index -= 1) {
      const start = startOfDay(now) - index * DAY;
      const date = new Date(start);
      buckets.push({
        start,
        end: start + DAY,
        label: date.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }),
        short: days === 7 ? date.toLocaleDateString(locale, { weekday: "short" }) : date.toLocaleDateString(locale, { day: "numeric", month: "short" })
      });
    }
  } else if (range === "90d") {
    const today = new Date(startOfDay(now));
    const monday = today.getTime() - ((today.getDay() + 6) % 7) * DAY;
    for (let index = 12; index >= 0; index -= 1) {
      const start = monday - index * 7 * DAY;
      const date = new Date(start);
      buckets.push({ start, end: start + 7 * DAY, label: `Week of ${date.toLocaleDateString(locale, { day: "numeric", month: "short" })}`, short: date.toLocaleDateString(locale, { day: "numeric", month: "short" }) });
    }
  } else {
    const current = new Date(now);
    let months = 12;
    if (range === "all" && finished.length) {
      const first = new Date(Math.min(...finished.map((entry) => entry.finishedAt || now)));
      months = Math.min(36, Math.max(1, (current.getFullYear() - first.getFullYear()) * 12 + current.getMonth() - first.getMonth() + 1));
    }
    for (let index = months - 1; index >= 0; index -= 1) {
      const start = new Date(current.getFullYear(), current.getMonth() - index, 1).getTime();
      const end = new Date(current.getFullYear(), current.getMonth() - index + 1, 1).getTime();
      const date = new Date(start);
      buckets.push({ start, end, label: date.toLocaleDateString(locale, { month: "long", year: "numeric" }), short: date.toLocaleDateString(locale, { month: "short" }) });
    }
  }
  for (const bucket of buckets) {
    const inside = finished.filter((entry) => entry.finishedAt >= bucket.start && entry.finishedAt < bucket.end);
    bucket.value = inside.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    bucket.count = inside.length;
  }
  return buckets;
}

/** Downloads that say something about a site's speed. */
function speedSamples(entries) {
  return entries.filter((entry) => saved(entry) && entry.site && entry.avgSpeed > 0 && (entry.bytes || 0) >= 5e6);
}

export function speedBySite(entries, limit = 8) {
  const bySite = new Map();
  for (const entry of speedSamples(entries)) {
    if (!bySite.has(entry.site)) bySite.set(entry.site, []);
    bySite.get(entry.site).push(entry.avgSpeed);
  }
  return [...bySite.entries()]
    .map(([site, speeds]) => ({ site, value: median(speeds), count: speeds.length }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/** cells[day][hour] with Monday = 0, in the viewer's time zone. */
export function heatCells(entries, site = "") {
  const buckets = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  for (const entry of speedSamples(entries)) {
    if (site && entry.site !== site) continue;
    const date = new Date(entry.startedAt || entry.finishedAt);
    buckets[(date.getDay() + 6) % 7][date.getHours()].push(entry.avgSpeed);
  }
  return buckets.map((day) => day.map((speeds) => (speeds.length ? { value: median(speeds), count: speeds.length } : null)));
}

export function topSites(entries, limit = 12) {
  const counts = new Map();
  for (const entry of entries) if (entry.site) counts.set(entry.site, (counts.get(entry.site) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([site]) => site);
}

/** What smart concurrency would choose for each frequent site, and why. */
export function settingsBySite(entries, limit = 8) {
  return topSites(entries.filter((entry) => entry.method !== "original"), limit).map((site) => {
    const recommendation = recommendConcurrency(entries, site);
    return { site, count: entries.filter((entry) => entry.site === site).length, ...recommendation };
  });
}
