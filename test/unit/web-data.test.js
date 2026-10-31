import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByDay, dayLabel, filterEntries, entrySubtitle, sitesOf } from "../../web/js/entries.js";
import { summary, periods, speedBySite, heatCells, inRange } from "../../web/js/insights-data.js";

const NOW = new Date(2026, 9, 31, 15, 0).getTime();
const HOUR = 3600000;
const entry = (overrides) => ({ id: Math.random().toString(36).slice(2), state: "done", kind: "hls", mode: "both", site: "a.com", title: "Clip", bytes: 100e6, received: 100e6, activeMs: 20000, avgSpeed: 5e6, height: 1080, finishedAt: NOW - HOUR, startedAt: NOW - 2 * HOUR, ...overrides });

test("day labels and grouping", () => {
  assert.equal(dayLabel(NOW - HOUR, NOW, "en-GB"), "Today");
  assert.equal(dayLabel(NOW - 24 * HOUR, NOW, "en-GB"), "Yesterday");
  assert.equal(dayLabel(NOW - 3 * 24 * HOUR, NOW, "en-GB"), "Wednesday");
  assert.equal(dayLabel(new Date(2025, 2, 4).getTime(), NOW, "en-GB"), "4 March 2025");
  const groups = groupByDay([entry({}), entry({ finishedAt: NOW - 2 * HOUR }), entry({ finishedAt: NOW - 30 * HOUR })], NOW);
  assert.deepEqual(groups.map((group) => group.entries.length), [2, 1]);
});

test("filters combine search, site, type, quality and status", () => {
  const list = [
    entry({ title: "Planet Earth", site: "bbc.co.uk" }),
    entry({ title: "Metropolis", site: "archive.org", kind: "mp4", height: 480 }),
    entry({ title: "Podcast", mode: "audio", height: null }),
    entry({ title: "Broken", state: "failed", errorCode: "expired" })
  ];
  assert.equal(filterEntries(list, { query: "planet" }).length, 1);
  assert.equal(filterEntries(list, { query: "ARCHIVE" }).length, 1);
  assert.equal(filterEntries(list, { type: "file" })[0].title, "Metropolis");
  assert.equal(filterEntries(list, { type: "audio" })[0].title, "Podcast");
  assert.equal(filterEntries(list, { quality: "sd" })[0].title, "Metropolis");
  assert.equal(filterEntries(list, { status: "failed" })[0].title, "Broken");
  assert.equal(entrySubtitle(list[3]), "a.com · The video link expired");
  assert.equal(sitesOf(list)[0].site, "a.com");
});

test("summary weights average speed by time and excludes cancellations from success rate", () => {
  const stats = summary([
    entry({ received: 100e6, activeMs: 10000 }),
    entry({ received: 100e6, activeMs: 40000 }),
    entry({ state: "failed" }),
    entry({ state: "cancelled" })
  ]);
  assert.equal(stats.avgSpeed, 200e6 / 50);
  assert.equal(stats.successRate, 2 / 3);
  assert.equal(stats.bytes, 200e6);
});

test("periods include empty days and range filtering is by calendar day", () => {
  const list = [entry({}), entry({ finishedAt: NOW - 3 * 24 * HOUR })];
  const days = periods(list, "7d", NOW, "en-GB");
  assert.equal(days.length, 7);
  assert.equal(days.reduce((sum, day) => sum + day.value, 0), 200e6);
  assert.equal(days.filter((day) => day.value).length, 2);
  assert.equal(inRange([entry({ finishedAt: NOW - 8 * 24 * HOUR })], "7d", NOW).length, 0);
  assert.equal(periods(list, "12m", NOW).length, 12);
});

test("speed by site uses medians; heat cells use local day and hour", () => {
  const list = [entry({ avgSpeed: 1e6 }), entry({ avgSpeed: 9e6 }), entry({ avgSpeed: 5e6 }), entry({ site: "b.com", avgSpeed: 2e6 })];
  const sites = speedBySite(list);
  assert.deepEqual(sites.map((item) => [item.site, item.value]), [["a.com", 5e6], ["b.com", 2e6]]);
  const cells = heatCells(list, "a.com");
  const start = new Date(NOW - 2 * HOUR);
  const cell = cells[(start.getDay() + 6) % 7][start.getHours()];
  assert.deepEqual(cell, { value: 5e6, count: 3 });
});
