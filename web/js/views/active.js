// Active: downloads in progress on any linked browser, updating live, with
// pause/resume/cancel that act on the browser doing the work.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { state, on, command, deviceName, bridge } from "../store.js";
import { emptyState, toast } from "../ui/controls.js";
import { confirmDialog } from "../ui/dialog.js";
import { pageHeader } from "./shell.js";
import { speedChart } from "../charts.js";
import { formatSize, formatSpeed, formatRemaining, formatClock, formatPercent, qualityLabel } from "/shared/format.js";
import { explain } from "/shared/explain.js";

function keyOf(job) {
  return `${job.deviceId}:${job.jobId}`;
}

function describeState(job) {
  if (job.final) {
    if (job.state === "done") return "Saved";
    if (job.state === "cancelled") return "Cancelled";
    return explain(job.errorCode).title;
  }
  if (job.paused || job.state === "paused") return "Paused";
  if (job.state === "recording") return `Recording live · ${formatClock(job.mediaDuration || 0)}`;
  if (job.state === "finishing") return "Finishing…";
  if (job.eta !== null && job.eta !== undefined) return formatRemaining(job.eta);
  return "Downloading…";
}

/** One card per job; updated in place so focus and hover survive updates. */
function createCard(job) {
  const titleNode = h("h2", { class: "headline truncate" });
  const meta = h("p", { class: "footnote truncate" });
  const status = h("p", { class: "job-status subheadline" });
  const percent = h("span", { class: "job-percent tabular" });
  const progress = h("progress", { class: "progress", max: 1 });
  const stats = h("dl", { class: "job-stats" });
  const graph = h("div", { class: "job-graph" });
  const controls = h("div", { class: "job-controls" });
  const card = h("article", { class: "job-card" },
    h("div", { class: "job-top" },
      h("div", { class: "tile" }, icon("download")),
      h("div", { class: "job-heading" }, titleNode, meta),
      percent),
    progress,
    h("div", { class: "job-line" }, status, controls),
    stats,
    graph);

  let lastControls = "";

  function stat(label, value) {
    return h("div", {}, h("dt", {}, label), h("dd", { class: "tabular" }, value));
  }

  card.update = (next) => {
    titleNode.textContent = next.title || "Downloading video";
    meta.textContent = [next.site, next.local ? "This browser" : next.deviceName || deviceName(next.deviceId), next.height ? qualityLabel(next.height) : ""].filter(Boolean).join(" · ");
    status.textContent = describeState(next);
    status.className = `job-status subheadline ${next.final ? next.state : ""}`;
    const determinate = !next.live && next.fraction !== null && next.fraction !== undefined;
    percent.textContent = next.final && next.state === "done" ? "" : determinate ? formatPercent(next.fraction) : "";
    if (determinate) {
      progress.value = next.final && next.state === "done" ? 1 : next.fraction;
      progress.classList.remove("indeterminate");
    } else {
      progress.removeAttribute("value");
      progress.classList.toggle("indeterminate", !next.final);
    }
    card.classList.toggle("final", Boolean(next.final));
    card.classList.toggle("paused", Boolean(next.paused));

    stats.replaceChildren(
      stat("Speed", next.paused ? "Paused" : formatSpeed(next.speed)),
      stat("Average", formatSpeed(next.avgSpeed)),
      stat(next.live ? "Recorded" : "Saved", next.estimatedBytes ? `${formatSize(next.written || next.received)} of ${formatSize(next.estimatedBytes)}` : formatSize(next.written || next.received)),
      stat("Running", next.startedAt ? formatClock((Date.now() - next.startedAt) / 1000) : "–"));

    const recent = next.recent || [];
    const width = graph.clientWidth;
    if (width && recent.length > 1) graph.replaceChildren(speedChart(width, { values: recent, slots: 90, height: 56, compact: true, label: "Speed over the last 90 seconds" }));

    const signature = `${next.final}:${next.paused}:${next.canPause}:${next.live}`;
    if (signature !== lastControls) {
      lastControls = signature;
      controls.replaceChildren(...buildControls(next));
    }
    card.job = next;
  };

  function buildControls(current) {
    if (current.final) return current.state === "done" ? [h("span", { class: "job-done" }, icon("checkCircle"), "Saved")] : [];
    const act = (action, label, { destructive = false, iconName } = {}) => h("button", {
      class: `button${destructive ? " destructive" : ""}`,
      type: "button",
      onClick: async (event) => {
        const button = event.currentTarget;
        const job = card.job;
        if (action === "cancel") {
          const confirmed = await confirmDialog({ title: "Cancel this download?", message: "The partly saved file is deleted.", confirmLabel: "Cancel Download", destructive: true });
          if (!confirmed) return;
        }
        button.disabled = true;
        try {
          await command(job, action);
        } catch (error) {
          toast(error.message, { error: true });
        } finally {
          setTimeout(() => { button.disabled = false; }, 1500);
        }
      }
    }, iconName ? icon(iconName) : null, label);
    const buttons = [];
    if (current.live) buttons.push(act("stop", "Stop and Save", { iconName: "stop" }));
    else if (current.canPause) buttons.push(current.paused ? act("resume", "Resume", { iconName: "play" }) : act("pause", "Pause", { iconName: "pause" }));
    buttons.push(act("cancel", "Cancel", { destructive: true }));
    return buttons;
  }

  card.update(job);
  return card;
}

export function mount(container, params, shell) {
  const { header, title, subtitle } = pageHeader("Active", { subtitle: "" });
  const list = h("div", { class: "job-list", "aria-live": "polite" });
  const empty = emptyState({
    iconName: "active",
    title: "Nothing downloading",
    message: "Start a download with MP4 Grabber and it appears here instantly, on this and every other device you're signed in on."
  });
  const page = h("div", { class: "page" }, header, list, empty);
  container.append(page);
  shell.watchTitle(title, "Active");
  const cards = new Map();

  function render() {
    const jobs = state.live;
    const seen = new Set();
    jobs.forEach((job, index) => {
      const key = keyOf(job);
      seen.add(key);
      let card = cards.get(key);
      if (!card) {
        card = createCard(job);
        cards.set(key, card);
      } else card.update(job);
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    });
    for (const [key, card] of cards) {
      if (!seen.has(key)) {
        card.remove();
        cards.delete(key);
      }
    }
    const running = jobs.filter((job) => !job.final).length;
    subtitle.textContent = running ? `${running} in progress` : jobs.length ? "Just finished" : "";
    empty.hidden = jobs.length > 0;
  }

  // Elapsed time keeps ticking between updates.
  const ticker = setInterval(() => cards.forEach((card) => card.update(card.job)), 1000);
  const unsubscribe = [on("live", render), on("devices", render)];
  render();

  return {
    unmount() {
      clearInterval(ticker);
      unsubscribe.forEach((stop) => stop());
    }
  };
}
