// Settings: account, download preferences (synced to every linked browser),
// privacy, notifications, linked browsers and appearance.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { state, on, updateSettings, setEncryption, deleteAllEntries, removeDevice, renameDevice, signOut, changePassword, deleteAccount, verifyPassword, bridge } from "../store.js";
import { toggle, segmented, toast, row, section, spinner } from "../ui/controls.js";
import { confirmDialog, passwordDialog, textDialog } from "../ui/dialog.js";
import { openSheet } from "../ui/sheet.js";
import { pageHeader } from "./shell.js";
import { currentTheme, applyTheme } from "../theme.js";
import { pushSupport, currentSubscription, enablePush, disablePush, sendTest } from "../push.js";
import { renderFilename, TEMPLATE_TOKENS } from "/shared/template.js";
import { normalizeSitePattern } from "/shared/privacy.js";
import { formatCount } from "/shared/format.js";

const QUALITY = [
  ["highest", "Highest available"], ["2160", "4K"], ["1440", "1440p"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["lowest", "Lowest available"]
];
const MODES = [["both", "Video with audio"], ["video", "Video only"], ["audio", "Audio only"]];
const CONNECTIONS = [["auto", "Automatic"], ["1", "1 · lightest"], ["3", "3 · balanced"], ["6", "6 · fastest"]];

function relative(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 90) return "active now";
  if (seconds < 3600) return `active ${format.format(-Math.round(seconds / 60), "minute")}`;
  if (seconds < 86400) return `active ${format.format(-Math.round(seconds / 3600), "hour")}`;
  return `active ${format.format(-Math.round(seconds / 86400), "day")}`;
}

function selectRow(label, options, value, onChange) {
  const select = h("select", { class: "select bare", "aria-label": label }, options.map(([optionValue, text]) => h("option", { value: optionValue, selected: optionValue === String(value) }, text)));
  select.addEventListener("change", () => onChange(select.value, select));
  return h("label", { class: "row" }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, label)), select);
}

function switchRow(title, subtitle, checked, onChange, disabled = false) {
  return row({ title, subtitle, trailing: toggle({ checked, label: title, onChange, disabled }) });
}

async function persist(changes) {
  try {
    await updateSettings(changes);
  } catch (error) {
    toast(error.message, { error: true });
  }
}

function download(filename, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = h("a", { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formulas in titles from the web.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function exportHistory(format) {
  const entries = state.entries.filter((entry) => !entry.unreadable);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    const clean = entries.map(({ sealed, seq, encrypted, ...rest }) => rest);
    download(`mp4-grabber-history-${stamp}.json`, "application/json", JSON.stringify(clean, null, 2));
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
  download(`mp4-grabber-history-${stamp}.csv`, "text/csv", `${lines.join("\r\n")}\r\n`);
}

function changePasswordSheet() {
  const fields = {
    current: h("input", { class: "input", type: "password", autocomplete: "current-password", "aria-label": "Current password" }),
    next: h("input", { class: "input", type: "password", autocomplete: "new-password", "aria-label": "New password" }),
    confirm: h("input", { class: "input", type: "password", autocomplete: "new-password", "aria-label": "Confirm new password" })
  };
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { class: "button primary large wide", type: "submit" }, "Change Password");
  const form = h("form", { class: "stack-form", novalidate: true },
    h("label", {}, h("span", { class: "form-label" }, "Current password"), fields.current),
    h("label", {}, h("span", { class: "form-label" }, "New password"), fields.next),
    h("label", {}, h("span", { class: "form-label" }, "Confirm new password"), fields.confirm),
    h("p", { class: "footnote" }, "Your history stays encrypted with the same key; only the password that unlocks it changes. Other devices will need to sign in again."),
    error, submit);
  const sheet = openSheet({ title: "Change Password", content: form });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const fail = (message) => { error.textContent = message; error.hidden = false; submit.disabled = false; submit.textContent = "Change Password"; };
    if (fields.next.value.length < 10) return fail("Use at least 10 characters.");
    if (fields.next.value !== fields.confirm.value) return fail("The new passwords don't match.");
    submit.disabled = true;
    submit.textContent = "Changing…";
    try {
      await changePassword(fields.current.value, fields.next.value);
      sheet.close();
      toast("Password changed");
    } catch (problem) {
      fail(problem.message);
    }
  });
  setTimeout(() => fields.current.focus(), 50);
}

export function mount(container, params, shell) {
  const { header, title } = pageHeader("Settings");
  const body = h("div");
  const page = h("div", { class: "page narrow" }, header, body);
  container.append(page);
  shell.watchTitle(title, "Settings");

  let encryptionBusy = null;
  let pushState = { subscribed: false, checking: true, busy: false };

  async function refreshPush() {
    pushState.subscribed = Boolean(await currentSubscription());
    pushState.checking = false;
    render();
  }

  function accountSection() {
    return section({ title: "Account", children: [
      row({ title: "Email", value: state.user.email }),
      row({ title: "Member since", value: new Date(state.user.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) }),
      row({ title: "Change Password…", className: "action", onClick: changePasswordSheet }),
      row({ title: "Sign Out", className: "action", onClick: async () => { await signOut(); } })
    ] });
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
      saveTimer = setTimeout(() => persist({ filenameTemplate: template.value.trim() || "{title}" }), 600);
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
      footer: "These apply to every connected browser. Automatic picks the number of parallel connections that has been fastest on each site.",
      children: [
        selectRow("Default quality", QUALITY, settings.quality, (value) => persist({ quality: value })),
        selectRow("Save", MODES, settings.mode, (value) => persist({ mode: value })),
        selectRow("Parallel connections", CONNECTIONS, settings.concurrency, (value) => persist({ concurrency: value })),
        h("div", { class: "row template-row" }, h("div", { class: "row-main" },
          h("div", { class: "row-title" }, "File name"),
          template, tokens, preview))
      ]
    });
  }

  function privacySection() {
    const settings = state.settings;
    const sites = settings.neverSync || [];
    const addInput = h("input", { class: "input", placeholder: "example.com", spellcheck: "false", autocomplete: "off", "aria-label": "Site to keep off the Library" });
    const add = async () => {
      const site = normalizeSitePattern(addInput.value);
      if (!site) {
        toast("Enter a site such as example.com", { error: true });
        return;
      }
      if (sites.includes(site)) return;
      await persist({ neverSync: [...sites, site] });
      addInput.value = "";
    };
    addInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); add(); } });

    const encryptionRow = encryptionBusy !== null
      ? row({ title: "Encrypt history", subtitle: `Re-sealing your history… ${Math.round(encryptionBusy * 100)}%`, trailing: spinner() })
      : switchRow("Encrypt history", settings.encryptHistory ? "Titles, sites and links are encrypted with your password" : "Stored readable on the server", settings.encryptHistory, async (checked, input) => {
        const confirmed = await confirmDialog(checked
          ? { title: "Encrypt your history?", message: `All ${formatCount(state.entries.length)} downloads will be encrypted in this browser and uploaded again. If you forget your password, the history can't be recovered.`, confirmLabel: "Encrypt" }
          : { title: "Turn off encryption?", message: "Titles, sites and links will be stored readable on your server. Numbers like sizes and speeds are always readable.", confirmLabel: "Turn Off", destructive: true });
        if (!confirmed) {
          input.checked = !checked;
          return;
        }
        encryptionBusy = 0;
        render();
        try {
          await setEncryption(checked, (fraction) => { encryptionBusy = fraction; render(); });
          toast(checked ? "History encrypted" : "Encryption turned off");
        } catch (error) {
          toast(error.message, { error: true });
        } finally {
          encryptionBusy = null;
          render();
        }
      });

    return [
      section({
        title: "Privacy",
        footer: "Downloads in Incognito windows are never saved. Sites below stay on the computer that downloaded them and never reach the Library.",
        children: [
          encryptionRow,
          row({ title: "Incognito windows", value: "Never saved" }),
          ...sites.map((site) => row({
            title: site,
            leading: h("div", { class: "tile small" }, icon("globe")),
            subtitle: "Kept off the Library",
            trailing: h("button", { class: "button plain destructive", type: "button", "aria-label": `Remove ${site}`, onClick: () => persist({ neverSync: sites.filter((item) => item !== site) }) }, "Remove")
          })),
          h("div", { class: "row add-row" }, addInput, h("button", { class: "button", type: "button", onClick: add }, icon("plus"), "Add Site"))
        ]
      }),
      section({
        title: "Your Data",
        children: [
          row({ title: "Export as CSV", subtitle: "For spreadsheets", className: "action", onClick: () => exportHistory("csv") }),
          row({ title: "Export as JSON", subtitle: "Everything, including speed samples", className: "action", onClick: () => exportHistory("json") }),
          row({ title: "Delete All History…", className: "destructive", onClick: async () => {
            const confirmed = await confirmDialog({ title: "Delete all history?", message: `This removes ${formatCount(state.entries.length)} downloads from your Library on every device. Files on your computers aren't touched.`, confirmLabel: "Delete All", destructive: true });
            if (!confirmed) return;
            try {
              await deleteAllEntries();
              toast("History deleted");
            } catch (error) {
              toast(error.message, { error: true });
            }
          } })
        ]
      })
    ];
  }

  function notificationsSection() {
    const support = pushSupport();
    const settings = state.settings;
    const children = [];
    if (pushState.checking) {
      children.push(row({ title: "This device", trailing: spinner() }));
    } else if (!support.supported && !pushState.subscribed) {
      children.push(row({ title: "This device", subtitle: support.reason }));
    } else {
      children.push(switchRow("This device", pushState.subscribed ? "Notifications are on" : "Get a notification when a download ends", pushState.subscribed, async (checked, input) => {
        input.disabled = true;
        try {
          if (checked) await enablePush();
          else await disablePush();
          pushState.subscribed = checked;
          toast(checked ? "Notifications on for this device" : "Notifications off for this device");
        } catch (error) {
          input.checked = !checked;
          toast(error.message, { error: true });
        } finally {
          render();
        }
      }));
    }
    children.push(switchRow("Finished downloads", null, settings.notifyFinished, (checked) => persist({ notifyFinished: checked })));
    children.push(switchRow("Failed downloads", null, settings.notifyFailed, (checked) => persist({ notifyFailed: checked })));
    if (pushState.subscribed) {
      children.push(row({ title: "Send a Test Notification", className: "action", onClick: async () => {
        try {
          const result = await sendTest();
          toast(result.sent ? "Test sent" : "No device accepted the notification", { error: !result.sent });
        } catch (error) {
          toast(error.message, { error: true });
        }
      } }));
    }
    return section({
      title: "Notifications",
      footer: settings.encryptHistory ? "With encryption on, alerts show the size and time but not the title, because the server can't read it." : null,
      children
    });
  }

  function browsersSection() {
    const devices = state.devices;
    const children = devices.map((device) => {
      const here = bridge.status.connected && bridge.status.deviceId === device.id;
      return row({
        leading: h("div", { class: "tile small" }, icon("laptop")),
        title: h("div", { class: "row-title" }, device.name, here ? h("span", { class: "badge accent inline-badge" }, "This browser") : null),
        subtitle: [device.browser, relative(device.lastSeen)].filter(Boolean).join(" · "),
        trailing: h("div", { class: "row-buttons" },
          h("button", { class: "button plain", type: "button", onClick: async () => {
            const name = await textDialog({ title: "Rename Browser", value: device.name, confirmLabel: "Rename" });
            if (!name) return;
            try { await renameDevice(device.id, name); } catch (error) { toast(error.message, { error: true }); }
          } }, "Rename"),
          h("button", { class: "button plain destructive", type: "button", onClick: async () => {
            const confirmed = await confirmDialog({ title: `Disconnect ${device.name}?`, message: "It stops syncing immediately and forgets your encryption key. Its past downloads stay in your Library.", confirmLabel: "Disconnect", destructive: true });
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
    if (!devices.length) children.push(row({ title: "No browsers connected yet", subtitle: "Follow the steps below to connect one." }));
    children.push(h("a", { class: "row action", href: "/api/extension.zip", download: "" },
      h("div", { class: "tile small" }, icon("download")),
      h("div", { class: "row-main" }, h("div", { class: "row-title" }, "Download MP4 Grabber for Chrome"), h("div", { class: "row-subtitle" }, "Already set up to connect to this Library"))));
    const steps = h("ol", { class: "steps footnote" },
      h("li", {}, "Download MP4 Grabber above and unzip it (double-click the file)."),
      h("li", {}, "In Chrome, open ", h("strong", {}, "chrome://extensions"), ", turn on Developer mode, click Load unpacked and choose the unzipped MP4 Grabber folder. Remove any older copy first."),
      h("li", {}, "Click the MP4 Grabber icon, choose Connect Library, then Continue. The address is already filled in: ", h("strong", { class: "tabular" }, location.origin)),
      h("li", {}, "Approve the request in the tab that opens."));
    const node = section({ title: "Browsers", children });
    node.id = "browsers";
    node.append(steps);
    return node;
  }

  function appearanceSection() {
    const control = segmented({
      options: [{ value: "system", label: "Automatic" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }],
      value: currentTheme(),
      label: "Appearance",
      onChange: (value) => applyTheme(value)
    });
    return section({ title: "Appearance", children: [row({ title: "Theme", trailing: control })] });
  }

  function dangerSection() {
    return section({ children: [row({ title: "Delete Account…", className: "destructive", onClick: async () => {
      await passwordDialog({
        title: "Delete your account?",
        message: "Your whole Library, linked browsers and settings are deleted from the server. This can't be undone.",
        confirmLabel: "Delete",
        destructive: true,
        onSubmit: async (password) => {
          await verifyPassword(password).catch(() => { throw new Error("That password is incorrect."); });
          await deleteAccount(password);
        }
      });
    } })] });
  }

  function render() {
    if (!state.settings) return;
    const active = document.activeElement;
    const keepFocus = active && body.contains(active) && active.classList.contains("template-input");
    body.replaceChildren(accountSection(), downloadsSection(), ...privacySection(), notificationsSection(), browsersSection(), appearanceSection(), dangerSection());
    if (keepFocus) {
      const input = body.querySelector(".template-input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // Re-render on settings changes, except while someone is typing a template.
  const unsubscribe = [
    on("settings", () => { if (!document.activeElement?.classList.contains("template-input")) render(); }),
    on("devices", render),
    on("bridge", render)
  ];
  render();
  refreshPush();
  if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  return { unmount: () => unsubscribe.forEach((stop) => stop()) };
}
