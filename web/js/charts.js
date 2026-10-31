// Charts drawn as SVG at the container's real width (re-rendered on resize),
// so text stays crisp and never scales. Every chart has a table view and
// keyboard-reachable values; tooltips add detail but never gate it.
//
// Marks follow one spec: 2 px lines over a 10 % wash, bars ≤ 24 px with a
// 4 px rounded data end and a square baseline, hairline solid grid lines,
// and text in ink colours, never the series colour.

import { h, s, clear } from "./dom.js";
import { formatClock } from "/shared/format.js";

// ---------- scales ----------

export function niceMax(value) {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

function ticks(max, count = 4) {
  return Array.from({ length: count + 1 }, (_, index) => (max / count) * index);
}

/** Speed axis unit: MB/s unless everything is under 1 MB/s. */
export function speedUnit(max) {
  return max >= 1e6 ? { divisor: 1e6, label: "MB/s" } : { divisor: 1e3, label: "KB/s" };
}

function formatAxisNumber(value) {
  if (value === 0) return "0";
  if (value < 10) return Number(value.toFixed(1)).toString();
  return Math.round(value).toLocaleString();
}

function niceTimeStep(totalSeconds, target = 5) {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((step) => totalSeconds / step <= target) || 7200;
}

// ---------- tooltip ----------

let tooltipNode = null;
function tooltip() {
  tooltipNode ||= document.body.appendChild(h("div", { class: "tooltip", role: "presentation" }));
  return tooltipNode;
}

export function showTooltip(x, y, value, label) {
  const node = tooltip();
  node.replaceChildren(h("strong", {}, value), label);
  node.classList.add("visible");
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2));
  const top = y - height - 14 < 8 ? y + 16 : y - height - 14;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

export function hideTooltip() {
  tooltipNode?.classList.remove("visible");
}

// ---------- frame: title, table toggle, responsive redraw ----------

/**
 * A chart card. `draw(width)` returns an SVG; `table()` returns a <table>.
 */
export function chartCard({ title, subtitle, draw, table, height, actions }) {
  const plot = h("div", { class: "chart-plot", style: height ? { "min-height": `${height}px` } : undefined });
  const tableHost = h("div", { class: "chart-table", hidden: true });
  let showingTable = false;
  const toggle = h("button", { type: "button", class: "button plain chart-toggle", "aria-pressed": "false", onClick: () => {
    showingTable = !showingTable;
    toggle.setAttribute("aria-pressed", String(showingTable));
    toggle.textContent = showingTable ? "Show Chart" : "Show as Table";
    plot.hidden = showingTable;
    tableHost.hidden = !showingTable;
    if (showingTable) tableHost.replaceChildren(table());
  } }, "Show as Table");

  const card = h("figure", { class: "chart-card" },
    h("figcaption", { class: "chart-header" },
      h("div", {}, h("h3", { class: "chart-title" }, title), subtitle ? h("p", { class: "chart-subtitle" }, subtitle) : null),
      h("div", { class: "chart-actions" }, actions, table ? toggle : null)),
    plot,
    tableHost);

  let lastWidth = 0;
  const observer = new ResizeObserver(() => {
    const width = Math.floor(plot.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    plot.replaceChildren(draw(width));
  });
  observer.observe(plot);
  card.redraw = () => {
    lastWidth = 0;
    const width = Math.floor(plot.clientWidth);
    if (width) {
      lastWidth = width;
      plot.replaceChildren(draw(width));
    }
    if (showingTable) tableHost.replaceChildren(table());
  };
  return card;
}

export function dataTable(headers, rows) {
  return h("table", { class: "data-table" },
    h("thead", {}, h("tr", {}, headers.map((header, index) => h("th", { scope: "col", class: index ? "numeric" : "" }, header)))),
    h("tbody", {}, rows.map((cells) => h("tr", {}, cells.map((cell, index) => (index ? h("td", { class: "numeric" }, cell) : h("th", { scope: "row" }, cell)))))));
}

// ---------- shapes ----------

function columnPath(x, y, width, height, radius = 4) {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function barPath(x, y, width, height, radius = 4) {
  const r = Math.min(radius, height / 2, width);
  return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
}

function runs(points) {
  const result = [];
  let current = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length) result.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) result.push(current);
  return result;
}

// ---------- speed over time (line + wash) ----------

/**
 * values: bytes/second per sample (null = paused). interval: ms per sample.
 * options.average draws a labelled reference line.
 * options.compact draws no axes (live cards); options.slots fixes the x range.
 */
export function speedChart(width, { values, interval = 1000, average = null, height = 200, compact = false, slots = null, label = "Download speed" }) {
  const series = slots ? values.slice(-slots) : values;
  const count = slots || series.length;
  const margin = compact ? { top: 6, right: 2, bottom: 2, left: 2 } : { top: 14, right: 14, bottom: 26, left: 44 };
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = height - margin.top - margin.bottom;
  const peak = Math.max(1, ...series.filter((value) => value !== null), average || 0);
  const unit = speedUnit(peak);
  const max = niceMax(peak / unit.divisor) * unit.divisor;
  const offset = count - series.length;
  const x = (index) => margin.left + (count <= 1 ? plotWidth / 2 : ((index + offset) / (count - 1)) * plotWidth);
  const y = (value) => margin.top + plotHeight - (value / max) * plotHeight;
  const baseline = margin.top + plotHeight;
  const svg = s("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });

  if (!compact) {
    for (const tick of ticks(max)) {
      const ty = Math.round(y(tick)) + 0.5;
      svg.append(s("line", { class: tick === 0 ? "axis" : "grid", x1: margin.left, x2: width - margin.right, y1: ty, y2: ty }));
      svg.append(s("text", { class: "tick", x: margin.left - 8, y: ty + 4, "text-anchor": "end" }, formatAxisNumber(tick / unit.divisor)));
    }
    svg.append(s("text", { class: "tick unit", x: margin.left - 8, y: margin.top - 4, "text-anchor": "end" }, unit.label));
    const totalSeconds = (count * interval) / 1000;
    const step = niceTimeStep(totalSeconds, Math.max(2, Math.floor(plotWidth / 90)));
    for (let second = 0; second <= totalSeconds; second += step) {
      const tx = margin.left + (second / Math.max(1, totalSeconds)) * plotWidth;
      svg.append(s("text", { class: "tick", x: tx, y: height - 6, "text-anchor": second === 0 ? "start" : "middle" }, formatClock(second)));
    }
  } else {
    svg.append(s("line", { class: "axis", x1: 0, x2: width, y1: baseline + 0.5, y2: baseline + 0.5 }));
  }

  const points = series.map((value, index) => ({ x: x(index), y: value === null ? null : y(value), value, index }));
  for (const run of runs(points)) {
    if (run.length === 1) {
      svg.append(s("circle", { class: "series-dot", cx: run[0].x, cy: run[0].y, r: 2 }));
      continue;
    }
    const line = run.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join("");
    svg.append(s("path", { class: "series-wash", d: `${line}L${run[run.length - 1].x.toFixed(1)},${baseline}L${run[0].x.toFixed(1)},${baseline}Z` }));
    svg.append(s("path", { class: "series-line", d: line }));
  }

  if (average && !compact) {
    const ay = Math.round(y(average)) + 0.5;
    svg.append(s("line", { class: "reference", x1: margin.left, x2: width - margin.right, y1: ay, y2: ay }));
    const text = `Average ${formatAxisNumber(average / unit.divisor)} ${unit.label}`;
    const labelY = ay - 6 < margin.top + 10 ? ay + 14 : ay - 6;
    svg.append(s("text", { class: "reference-label", x: width - margin.right, y: labelY, "text-anchor": "end" }, text));
  }

  if (!compact && points.length) addCrosshair(svg, { points, margin, height, width, baseline, describe: (point) => [
    point.value === null ? "Paused" : `${formatAxisNumber(point.value / unit.divisor)} ${unit.label}`,
    `at ${formatClock((point.index * interval) / 1000)}`
  ] });
  return svg;
}

function addCrosshair(svg, { points, margin, height, width, describe }) {
  const line = s("line", { class: "crosshair", y1: margin.top, y2: height - margin.bottom, visibility: "hidden" });
  const dot = s("circle", { class: "crosshair-dot", r: 4, visibility: "hidden" });
  const overlay = s("rect", { class: "overlay", x: margin.left, y: 0, width: Math.max(0, width - margin.left - margin.right), height, tabindex: "0", "aria-label": "Speed values. Use the arrow keys to move through them." });
  svg.append(line, dot, overlay);
  let active = -1;

  function show(index, clientX, clientY) {
    active = Math.max(0, Math.min(points.length - 1, index));
    const point = points[active];
    line.setAttribute("x1", point.x);
    line.setAttribute("x2", point.x);
    line.removeAttribute("visibility");
    if (point.y === null) dot.setAttribute("visibility", "hidden");
    else {
      dot.setAttribute("cx", point.x);
      dot.setAttribute("cy", point.y);
      dot.removeAttribute("visibility");
    }
    const [value, label] = describe(point);
    const box = svg.getBoundingClientRect();
    showTooltip(clientX ?? box.left + point.x, clientY ?? box.top + (point.y ?? margin.top), value, label);
  }
  function hide() {
    line.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    hideTooltip();
  }
  function nearest(clientX) {
    const box = svg.getBoundingClientRect();
    const localX = clientX - box.left;
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
      if (Math.abs(points[index].x - localX) < Math.abs(points[best].x - localX)) best = index;
    }
    return best;
  }
  overlay.addEventListener("pointermove", (event) => {
    const index = nearest(event.clientX);
    const box = svg.getBoundingClientRect();
    show(index, box.left + points[index].x, box.top + (points[index].y ?? margin.top));
  });
  overlay.addEventListener("pointerleave", hide);
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("focus", () => show(active < 0 ? points.length - 1 : active));
  overlay.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") show(active - step);
    else if (event.key === "ArrowRight") show(active + step);
    else if (event.key === "Home") show(0);
    else if (event.key === "End") show(points.length - 1);
    else return;
    event.preventDefault();
  });
}

// ---------- columns (one value per period) ----------

export function columnChart(width, { items, format, axisFormat = format, height = 200, label }) {
  const margin = { top: 14, right: 8, bottom: 26, left: 48 };
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = height - margin.top - margin.bottom;
  const max = niceMax(Math.max(0, ...items.map((item) => item.value)));
  const band = plotWidth / Math.max(1, items.length);
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const y = (value) => margin.top + plotHeight - (value / max) * plotHeight;
  const svg = s("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
  for (const tick of ticks(max)) {
    const ty = Math.round(y(tick)) + 0.5;
    svg.append(s("line", { class: tick === 0 ? "axis" : "grid", x1: margin.left, x2: width - margin.right, y1: ty, y2: ty }));
    svg.append(s("text", { class: "tick", x: margin.left - 8, y: ty + 4, "text-anchor": "end" }, axisFormat(tick)));
  }
  const labelEvery = Math.max(1, Math.ceil(items.length / Math.max(1, Math.floor(plotWidth / 64))));
  items.forEach((item, index) => {
    const cx = margin.left + band * index + band / 2;
    if (item.value > 0) {
      const top = y(item.value);
      const bar = s("path", { class: "bar", d: columnPath(cx - barWidth / 2, top, barWidth, margin.top + plotHeight - top) });
      svg.append(bar);
    }
    const hit = s("rect", { class: "hit", x: cx - band / 2, y: margin.top, width: band, height: plotHeight, tabindex: "0", "aria-label": `${item.label}: ${format(item.value)}` });
    const show = () => {
      const box = hit.getBoundingClientRect();
      showTooltip(box.left + box.width / 2, box.top + (y(item.value) - margin.top), format(item.value), item.label);
      hit.classList.add("active");
    };
    const hide = () => { hideTooltip(); hit.classList.remove("active"); };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", show);
    hit.addEventListener("blur", hide);
    svg.append(hit);
    if (index % labelEvery === 0) {
      svg.append(s("text", { class: "tick", x: cx, y: height - 6, "text-anchor": "middle" }, item.short || item.label));
    }
  });
  return svg;
}

// ---------- horizontal bars (ranked categories) ----------

export function barChart(width, { items, format, label, max: fixedMax }) {
  const rowHeight = 36;
  const barHeight = 20;
  const labelWidth = Math.min(180, Math.max(110, width * 0.3));
  const valueWidth = 84;
  const height = items.length * rowHeight;
  const plotWidth = Math.max(20, width - labelWidth - valueWidth);
  const max = fixedMax || Math.max(1, ...items.map((item) => item.value));
  const svg = s("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
  svg.append(s("line", { class: "axis", x1: labelWidth + 0.5, x2: labelWidth + 0.5, y1: 0, y2: height }));
  items.forEach((item, index) => {
    const top = index * rowHeight + (rowHeight - barHeight) / 2;
    const barWidth = Math.max(item.value > 0 ? 3 : 0, (item.value / max) * plotWidth);
    svg.append(s("text", { class: "category", x: labelWidth - 10, y: top + barHeight / 2 + 4, "text-anchor": "end" }, truncate(item.label, Math.floor((labelWidth - 14) / 7))));
    if (barWidth) svg.append(s("path", { class: "bar", d: barPath(labelWidth + 1, top, barWidth, barHeight) }));
    svg.append(s("text", { class: "bar-value", x: labelWidth + barWidth + 8, y: top + barHeight / 2 + 4 }, format(item.value)));
    const hit = s("rect", { class: "hit", x: 0, y: index * rowHeight, width, height: rowHeight, tabindex: "0", "aria-label": `${item.label}: ${format(item.value)}${item.detail ? `, ${item.detail}` : ""}` });
    const show = () => {
      const box = hit.getBoundingClientRect();
      showTooltip(box.left + labelWidth + barWidth, box.top + 6, format(item.value), `${item.label}${item.detail ? ` · ${item.detail}` : ""}`);
      hit.classList.add("active");
    };
    const hide = () => { hideTooltip(); hit.classList.remove("active"); };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", show);
    hit.addEventListener("blur", hide);
    svg.append(hit);
  });
  return svg;
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, Math.max(1, length - 1))}…` : text;
}

// ---------- heatmap (day × hour) ----------

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** cells[day][hour] = { value, count } or null. Values are binned into 7 steps. */
export function heatmap(width, { cells, format, label }) {
  const margin = { top: 4, right: 4, bottom: 22, left: 36 };
  const gap = 2;
  const cell = Math.max(8, Math.min(26, (width - margin.left - margin.right) / 24 - gap));
  const height = margin.top + 7 * (cell + gap) + margin.bottom;
  const svg = s("svg", { class: "chart heatmap", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
  const values = cells.flat().filter(Boolean).map((item) => item.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const step = (value) => (max === min ? 3 : Math.min(6, Math.floor(((value - min) / (max - min)) * 7)));
  for (let day = 0; day < 7; day += 1) {
    const top = margin.top + day * (cell + gap);
    svg.append(s("text", { class: "tick", x: margin.left - 8, y: top + cell / 2 + 4, "text-anchor": "end" }, DAYS[day]));
    for (let hour = 0; hour < 24; hour += 1) {
      const left = margin.left + hour * (cell + gap);
      const item = cells[day][hour];
      const rect = s("rect", { class: item ? `cell heat-${step(item.value)}` : "cell empty", x: left, y: top, width: cell, height: cell, rx: 3, tabindex: item ? "0" : null });
      if (item) {
        const when = `${DAYS[day]} ${String(hour).padStart(2, "0")}:00–${String((hour + 1) % 24).padStart(2, "0")}:00`;
        rect.setAttribute("aria-label", `${when}: ${format(item.value)}, ${item.count} download${item.count === 1 ? "" : "s"}`);
        const show = () => {
          const box = rect.getBoundingClientRect();
          showTooltip(box.left + box.width / 2, box.top, format(item.value), `${when} · ${item.count} download${item.count === 1 ? "" : "s"}`);
          rect.classList.add("active");
        };
        const hide = () => { hideTooltip(); rect.classList.remove("active"); };
        rect.addEventListener("pointerenter", show);
        rect.addEventListener("pointerleave", hide);
        rect.addEventListener("focus", show);
        rect.addEventListener("blur", hide);
      }
      svg.append(rect);
    }
  }
  for (const hour of [0, 6, 12, 18]) {
    svg.append(s("text", { class: "tick", x: margin.left + hour * (cell + gap), y: height - 6 }, `${String(hour).padStart(2, "0")}:00`));
  }
  return svg;
}

export function heatLegend(minLabel, maxLabel) {
  return h("div", { class: "heat-legend", "aria-hidden": "true" },
    h("span", {}, minLabel),
    h("span", { class: "heat-steps" }, Array.from({ length: 7 }, (_, index) => h("span", { class: `heat-${index}` }))),
    h("span", {}, maxLabel));
}

export { clear };
