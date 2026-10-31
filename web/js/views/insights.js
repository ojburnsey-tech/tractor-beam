// Insights: how much, how fast, and when. One filter row (the date range)
// scopes every number and chart on the page.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { state, on } from "../store.js";
import { emptyState, segmented } from "../ui/controls.js";
import { pageHeader } from "./shell.js";
import { chartCard, columnChart, barChart, heatmap, heatLegend, dataTable, speedUnit } from "../charts.js";
import { RANGES, inRange, summary, periods, speedBySite, heatCells, topSites, settingsBySite } from "../insights-data.js";
import { formatSize, formatSpeed, formatCount, formatDurationWords, formatPercent } from "/shared/format.js";

let rememberedRange = "30d";

function tile(label, value, detail) {
  return h("div", { class: "stat-tile" }, h("p", { class: "stat-label" }, label), h("p", { class: "stat-value" }, value), detail ? h("p", { class: "stat-detail" }, detail) : null);
}

function sizeAxis(value) {
  if (!value) return "0";
  return formatSize(value).replace(" bytes", " B");
}

export function mount(container, params, shell) {
  let range = rememberedRange;
  let heatSite = "";
  const { header, title } = pageHeader("Insights");
  const control = segmented({
    options: RANGES.map((item) => ({ value: item.value, label: item.label })),
    value: range,
    label: "Time range",
    onChange: (value) => {
      range = value;
      rememberedRange = value;
      render();
    }
  });
  const filters = h("div", { class: "toolbar insights-filters" }, control);
  const body = h("div", { class: "insights-body" });
  const page = h("div", { class: "page" }, header, filters, body);
  container.append(page);
  shell.watchTitle(title, "Insights");

  function render() {
    if (!state.loaded) return;
    if (!state.entries.length) {
      filters.hidden = true;
      body.replaceChildren(emptyState({ iconName: "insights", title: "No insights yet", message: "After a few downloads you'll see how much you've saved, which sites are fastest, and the best times to download." }));
      return;
    }
    filters.hidden = false;
    const entries = inRange(state.entries, range);
    const stats = summary(entries);
    const rangeLabel = RANGES.find((item) => item.value === range).label;

    const hero = h("section", { class: "insights-hero" },
      h("p", { class: "stat-label" }, range === "all" ? "Downloaded in total" : `Downloaded in the last ${rangeLabel.toLowerCase()}`),
      h("p", { class: "hero-figure" }, formatSize(stats.bytes)),
      h("p", { class: "stat-detail" }, `${formatCount(stats.saved)} video${stats.saved === 1 ? "" : "s"} saved${stats.mediaSeconds ? `, ${formatDurationWords(stats.mediaSeconds)} to watch` : ""}`));

    const tiles = h("div", { class: "stat-tiles" },
      tile("Downloads", formatCount(stats.count), stats.failed ? `${formatCount(stats.failed)} failed` : "None failed"),
      tile("Average speed", stats.avgSpeed ? formatSpeed(stats.avgSpeed) : "–", "Across active download time"),
      tile("Success rate", stats.successRate === null ? "–" : formatPercent(stats.successRate), "Cancelled downloads excluded"),
      tile("Media saved", stats.mediaSeconds ? formatDurationWords(stats.mediaSeconds) : "–", "Total running time"));

    const buckets = periods(entries, range);
    const volume = chartCard({
      title: "Data downloaded",
      subtitle: range === "90d" ? "Per week" : range === "7d" || range === "30d" ? "Per day" : "Per month",
      height: 200,
      draw: (width) => columnChart(width, { items: buckets, format: (value) => formatSize(value), axisFormat: sizeAxis, label: "Data downloaded per period" }),
      table: () => dataTable(["Period", "Downloads", "Data"], buckets.map((bucket) => [bucket.label, formatCount(bucket.count), formatSize(bucket.value)]))
    });

    const sites = speedBySite(entries);
    const siteCard = sites.length ? chartCard({
      title: "Speed by site",
      subtitle: "Median average speed per download",
      draw: (width) => barChart(width, { items: sites.map((item) => ({ label: item.site, value: item.value, detail: `${item.count} download${item.count === 1 ? "" : "s"}` })), format: (value) => formatSpeed(value), label: "Median download speed by site" }),
      table: () => dataTable(["Site", "Downloads", "Median speed"], sites.map((item) => [item.site, formatCount(item.count), formatSpeed(item.value)]))
    }) : null;

    const siteOptions = topSites(entries);
    if (heatSite && !siteOptions.includes(heatSite)) heatSite = "";
    const cells = heatCells(entries, heatSite);
    const filled = cells.flat().filter(Boolean);
    const siteSelect = h("select", { class: "pill-select", "aria-label": "Site for the time-of-day chart" },
      h("option", { value: "" }, "All Sites"),
      siteOptions.map((site) => h("option", { value: site, selected: site === heatSite }, site)));
    siteSelect.addEventListener("change", () => {
      heatSite = siteSelect.value;
      render();
    });
    const unitMax = filled.length ? Math.max(...filled.map((item) => item.value)) : 0;
    const unit = speedUnit(unitMax);
    const timeCard = chartCard({
      title: "Speed by time of day",
      subtitle: filled.length ? "Median speed of downloads started in each hour, in your time zone" : "Not enough downloads in this range yet",
      actions: siteSelect,
      draw: (width) => {
        const chart = heatmap(width, { cells, format: (value) => formatSpeed(value), label: "Median download speed by day and hour" });
        if (!filled.length) return chart;
        const values = filled.map((item) => item.value);
        const wrapper = h("div", {}, chart, heatLegend(`${(Math.min(...values) / unit.divisor).toFixed(1)} ${unit.label}`, `${(Math.max(...values) / unit.divisor).toFixed(1)} ${unit.label}`));
        return wrapper;
      },
      table: () => {
        const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
        const rows = [];
        cells.forEach((day, dayIndex) => day.forEach((cell, hour) => {
          if (cell) rows.push([`${days[dayIndex]} ${String(hour).padStart(2, "0")}:00`, formatCount(cell.count), formatSpeed(cell.value)]);
        }));
        return dataTable(["When", "Downloads", "Median speed"], rows);
      }
    });

    const advice = settingsBySite(state.entries);
    const adviceSection = advice.length ? h("section", { class: "section" },
      h("div", { class: "section-header" }, h("h2", { class: "section-title large" }, "Best settings per site")),
      h("div", { class: "group" }, advice.map((item) => h("div", { class: "row" },
        h("div", { class: "tile small" }, icon("gauge")),
        h("div", { class: "row-main" },
          h("div", { class: "row-title" }, item.site),
          h("div", { class: "row-subtitle" }, item.reason)),
        h("div", { class: "row-value" }, h("span", { class: "badge accent tabular" }, `${item.level} connection${item.level === 1 ? "" : "s"}`))))),
      h("p", { class: "section-footer footnote" }, "Used when Parallel connections is set to Automatic. Based on all your downloads, not just this range.")) : null;

    body.replaceChildren(hero, tiles, volume, siteCard, timeCard, adviceSection);
  }

  const unsubscribe = [on("entries", render)];
  render();
  return { unmount: () => unsubscribe.forEach((stop) => stop()) };
}
