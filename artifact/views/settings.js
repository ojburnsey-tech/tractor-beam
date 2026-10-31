// Settings for the artifact edition: connected browsers (and connecting
// this one), download preferences synced to the extension, privacy, and
// export/import of history.

import { h } from "../../web/js/dom.js";
import { icon } from "../../web/js/icons.js";
import { state, on, updateSettings, deleteAllEntries, removeDevice, renameDevice, connectBrowser, deviceOnline, importEntries, saveFile, bridge } from "../../web/js/store.js";
import { toggle, toast, row, section, spinner } from "../../web/js/ui/controls.js";
import { confirmDialog, textDialog } from "../../web/js/ui/dialog.js";
import { pageHeader } from "../../web/js/views/shell.js";
import { currentFragment } from "../../web/js/router.js";
import { renderFilename, TEMPLATE_TOKENS } from "../../shared/template.js";
import { normalizeSitePattern } from "../../shared/privacy.js";
import { formatCount } from "../../shared/format.js";
import { EXTENSION_DOWNLOAD_URL } from "../config.js";

const QUALITY = [
  ["highest", "Highest available"], ["2160", "4K"], ["1440", "1440p"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["lowest", "Lowest available"]
];
const MODES = [["both", "Video with audio"], ["video", "Video only"], ["audio", "Audio only"]];
const CONNECTIONS = [["auto", "Automatic"], ["1", "1 · lightest"], ["3", "3 · balanced"], ["6", "6 · fastest"]];

function lastSeen(device) {
  if (deviceOnline(device.id)) return "Online now";
  const seconds = Math.round((Date.now() - (device.lastSeen || device.linkedAt || Date.now())) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 3600) return `Last seen ${format.format(-Math.max(1, Math.round(seconds / 60)), "minute")}`;
  if (seconds < 86400) return `Last seen ${format.format(-Math.round(seconds / 3600), "hour")}`;
  return `Last seen ${format.format(-Math.round(seconds / 86400), "day")}`;
}

function selectRow(label, options, value, onChange) {
  const select = h("select", { class: "select bare", "aria-label": label }, options.map(([optionValue, text]) => h("option", { value: optionValue, selected: optionValue === String(value) }, text)));
  select.addEventListener("change", () => onChange(select.value, select));
  return h("label", { class: "row" }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, label)), select);
}

async function persist(changes) {
  try {
    await updateSettings(changes);
  } catch (error) {
    toast(error.message, { error: true });
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function exportHistory(format) {
  const entries = state.entries;
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    if (format === "json") {
      await saveFile(`mp4-grabber-history-${stamp}.json`, JSON.stringify(entries, null, 2), "application/json");
      return;
    }
    const columns = [
      ["Finished", (entry) => new Date(entry.finishedAt).toISOString()],
      ["Title", (entry) => entry.title], ["Site", (entry) => entry.site], ["Status", (entry) => entry.state],
      ["Size (bytes)", (entry) => entry.bytes], ["Length (seconds)", (entry) => entry.mediaDuration && Math.round(entry.mediaDuration)],
      ["Height", (entry) => entry.height], ["Type", (entry) => entry.kind], ["Container", (entry) => entry.container],
      ["Average speed (bytes/s)", (entry) => entry.avgSpeed], ["Top speed (bytes/s)", (entry) => entry.peakSpeed],
      ["Time taken (seconds)", (entry) => entry.elapsedMs && Math.round(entry.elapsedMs / 1000)],
      ["Parallel connections", (entry) => entry.concurrency], ["Page", (entry) => entry.pageUrl], ["File name", (entry) => entry.filename],
      ["Error", (entry) => entry.errorCode]
    ];
    const lines = [columns.map(([name]) => csvCell(name)).join(",")];
    for (const entry of entries) lines.push(columns.map(([, read]) => csvCell(read(entry))).join(","));
    await saveFile(`mp4-grabber-history-${stamp}.csv`, `${lines.join("\r\n")}\r\n`, "text/csv");
  } catch (error) {
    if (error?.code !== "cancelled" && error?.code !== "declined") toast(error.message || "The file wasn't saved.", { error: true });
  }
}

export function mount(container, params, shell) {
  const { header, title } = pageHeader("Settings");
  const body = h("div");
  const page = h("div", { class: "page narrow" }, header, body);
  container.append(page);
  shell.watchTitle(title, "Settings");

  // "idle" → "asking" → "pending" (code shown) | "missing" (no extension answered)
  let pairing = { state: "idle", code: "" };

  async function startPairing() {
    pairing = { state: "asking", code: "" };
    render();
    const result = await connectBrowser();
    pairing = result.state === "pending" ? { state: "pending", code: result.code } : result.state === "paired" ? { state: "idle", code: "" } : { state: "missing", code: "" };
    render();
  }

  function connectCard() {
    if (bridge.status.connected) {
      return h("div", { class: "notice info connect-card" }, icon("checkCircle"), h("div", {},
        h("p", { class: "notice-title" }, "This browser is connected"),
        h("p", { class: "footnote" }, "Downloads from MP4 Grabber in this browser are saved here whenever this Library is open.")));
    }
    if (pairing.state === "pending") {
      return h("div", { class: "notice info connect-card" }, icon("laptop"), h("div", {},
        h("p", { class: "notice-title" }, "Approve in MP4 Grabber"),
        h("p", { class: "footnote" }, "A MP4 Grabber tab just opened. Check it shows this code, then choose Connect."),
        h("p", { class: "pair-code tabular" }, pairing.code)));
    }
    const missing = pairing.state === "missing";
    return h("div", { class: "notice info connect-card" }, icon("laptop"), h("div", { class: "connect-body" },
      h("p", { class: "notice-title" }, missing ? "MP4 Grabber didn't answer" : "Connect this browser"),
      h("p", { class: "footnote" }, missing
        ? "Install MP4 Grabber in this Chrome first (steps below), reload this page, then try again."
        : "Lets MP4 Grabber in this Chrome save its downloads here and show them live."),
      h("div", { class: "connect-actions" },
        h("button", { class: "button primary", type: "button", disabled: pairing.state === "asking", onClick: startPairing },
          pairing.state === "asking" ? spinner() : null, pairing.state === "asking" ? "Waiting for MP4 Grabber…" : missing ? "Try Again" : "Connect This Browser"))));
  }

  function browsersSection() {
    const children = state.devices.map((device) => {
      const here = bridge.status.connected && bridge.status.deviceId === device.id;
      return row({
        leading: h("div", { class: "tile small" }, icon("laptop")),
        title: h("div", { class: "row-title" }, device.name, here ? h("span", { class: "badge accent inline-badge" }, "This browser") : null),
        subtitle: [lastSeen(device), device.browser].filter(Boolean).join(" · "),
        trailing: h("div", { class: "row-buttons" },
          h("button", { class: "button plain", type: "button", onClick: async () => {
            const name = await textDialog({ title: "Rename Browser", value: device.name, confirmLabel: "Rename" });
            if (!name) return;
            try { await renameDevice(device.id, name); } catch (error) { toast(error.message, { error: true }); }
          } }, "Rename"),
          h("button", { class: "button plain destructive", type: "button", onClick: async () => {
            const confirmed = await confirmDialog({ title: `Disconnect ${device.name}?`, message: "It stops saving to this Library the next time it connects. Its past downloads stay here.", confirmLabel: "Disconnect", destructive: true });
            if (!confirmed) return;
            try {
              await removeDevice(device.id);
              toast(`${device.name} disconnected`);
            } catch (error) {
              toast(error.message, { error: true });
            }
          } }, "Disconnect"))
      });
    });
    if (!children.length) children.push(row({ title: "No browsers connected yet" }));
    const steps = h("ol", { class: "steps footnote" },
      h("li", {}, h("a", { href: EXTENSION_DOWNLOAD_URL, target: "_blank", rel: "noreferrer" }, "Download MP4 Grabber"), " and unzip it (double-click the file)."),
      h("li", {}, "In Chrome, open ", h("strong", {}, "chrome://extensions"), ", turn on Developer mode, click Load unpacked and choose the ", h("strong", {}, "extension"), " folder inside it. Remove any older copy first."),
      h("li", {}, "Come back here and choose Connect This Browser."));
    const node = h("section", { class: "section", id: "browsers" },
      h("div", { class: "section-header" }, h("h2", { class: "section-title" }, "Browsers")),
      connectCard(),
      h("div", { class: "group" }, children),
      h("p", { class: "section-footer footnote" }, "Keep this Library open in a tab (pin it) on each computer you download on. Downloads made while it's closed are kept by MP4 Grabber and arrive the next time you open it."),
      steps);
    return node;
  }

  function downloadsSection() {
    const settings = state.settings;
    const template = h("input", { class: "input template-input", value: settings.filenameTemplate, spellcheck: "false", autocomplete: "off", "aria-label": "File name template" });
    const preview = h("p", { class: "caption template-preview tabular" });
    const updatePreview = () => {
      const example = Object.fromEntries(TEMPLATE_TOKENS.map((item) => [item.token.slice(1, -1), item.example]));
      preview.textContent = `Example: ${renderFilename(template.value, example, new Date())}.mp4`;
    };
    updatePreview();
    let saveTimer;
    template.addEventListener("input", () => {
      updatePreview();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persist({ filenameTemplate: template.value.trim() || "{title}" }), 800);
    });
    const tokens = h("div", { class: "token-row" }, TEMPLATE_TOKENS.map((item) => h("button", { class: "button token", type: "button", onClick: () => {
      const start = template.selectionStart ?? template.value.length;
      const end = template.selectionEnd ?? template.value.length;
      template.setRangeText(item.token, start, end, "end");
      template.focus();
      template.dispatchEvent(new Event("input"));
    } }, item.label)));
    return section({
      title: "Downloads",
      footer: "Connected browsers pick these up the next time this Library is open. Automatic picks the number of parallel connections that has been fastest on each site.",
      children: [
        selectRow("Default quality", QUALITY, settings.quality, (value) => persist({ quality: value })),
        selectRow("Save", MODES, settings.mode, (value) => persist({ mode: value })),
        selectRow("Parallel connections", CONNECTIONS, settings.concurrency, (value) => persist({ concurrency: value })),
        h("div", { class: "row template-row" }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, "File name"), template, tokens, preview))
      ]
    });
  }

  function privacySection() {
    const sites = state.settings.neverSync || [];
    const addInput = h("input", { class: "input", placeholder: "example.com", spellcheck: "false", autocomplete: "off", "aria-label": "Site to keep out of the Library" });
    const add = async () => {
      const site = normalizeSitePattern(addInput.value);
      if (!site) {
        toast("Enter a site such as example.com", { error: true });
        return;
      }
      if (!sites.includes(site)) await persist({ neverSync: [...sites, site] });
      addInput.value = "";
    };
    addInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); add(); } });
    return section({
      title: "Privacy",
      footer: "Your Library is stored in this artifact, in a private area only your Claude account can read, even if you share the artifact. Downloads in Incognito windows are never saved. Sites listed here stay on the computer that downloaded them.",
      children: [
        row({ title: "Incognito windows", value: "Never saved" }),
        ...sites.map((site) => row({
          title: site,
          leading: h("div", { class: "tile small" }, icon("globe")),
          subtitle: "Kept out of the Library",
          trailing: h("button", { class: "button plain destructive", type: "button", "aria-label": `Remove ${site}`, onClick: () => persist({ neverSync: sites.filter((item) => item !== site) }) }, "Remove")
        })),
        h("div", { class: "row add-row" }, addInput, h("button", { class: "button", type: "button", onClick: add }, icon("plus"), "Add Site"))
      ]
    });
  }

  function dataSection() {
    const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true, id: "import-file" });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const list = Array.isArray(parsed) ? parsed : parsed?.entries;
        const { imported } = await importEntries(list);
        toast(imported ? `Imported ${formatCount(imported)} download${imported === 1 ? "" : "s"}` : "Everything in that file is already here");
      } catch (error) {
        toast(error.message || "That file couldn't be read.", { error: true });
      }
    });
    return section({
      title: "Your Data",
      footer: "If this browser can't connect, open MP4 Grabber, choose Library, then Export History, and import the file here.",
      children: [
        row({ title: "Export as CSV", subtitle: "For spreadsheets", className: "action", onClick: () => exportHistory("csv") }),
        row({ title: "Export as JSON", subtitle: "Everything, including speed samples", className: "action", onClick: () => exportHistory("json") }),
        row({ title: "Import from MP4 Grabber…", subtitle: "A history file exported from the extension", className: "action", onClick: () => fileInput.click() }),
        fileInput,
        row({ title: "Delete All History…", className: "destructive", onClick: async () => {
          const confirmed = await confirmDialog({ title: "Delete all history?", message: `This removes ${formatCount(state.entries.length)} downloads from your Library. Files on your computers aren't touched.`, confirmLabel: "Delete All", destructive: true });
          if (!confirmed) return;
          try {
            await deleteAllEntries();
            toast("History deleted");
          } catch (error) {
            toast(error.message, { error: true });
          }
        } })
      ]
    });
  }

  function phoneSection() {
    return section({
      title: "On Your Phone",
      footer: "Open this Library in the Claude app or at claude.ai on your phone. Live progress and the Pause and Cancel buttons work while the computer doing the download has this Library open.",
      children: [row({ leading: h("div", { class: "tile small" }, icon("phone")), title: "Same Library everywhere", subtitle: "History, insights and Send to Computer work on any device" })]
    });
  }

  function render() {
    const active = document.activeElement;
    const typing = active && body.contains(active) && active.classList.contains("template-input");
    if (typing) return;
    body.replaceChildren(browsersSection(), downloadsSection(), privacySection(), dataSection(), phoneSection());
  }

  const unsubscribe = [on("settings", render), on("devices", render), on("bridge", render), on("paired", () => {
    pairing = { state: "idle", code: "" };
    toast("Browser connected");
    render();
  })];
  render();
  if (currentFragment() === "browsers") setTimeout(() => document.getElementById("browsers")?.scrollIntoView({ block: "start" }), 50);
  return { unmount: () => unsubscribe.forEach((stop) => stop()) };
}
