// Send to Computer: paste a link here (e.g. on your phone) and it waits in
// MP4 Grabber on the chosen computer.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { state, on, sendLink, removeLink, deviceName } from "../store.js";
import { emptyState, toast } from "../ui/controls.js";
import { pageHeader } from "./shell.js";

function relative(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 60) return "just now";
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), "hour");
  return format.format(-Math.round(seconds / 86400), "day");
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function mount(container, params, shell) {
  const { header, title } = pageHeader("Send to Computer", { subtitle: "Send a video page or playlist link to a computer running MP4 Grabber." });
  const url = h("input", { class: "input", type: "url", inputmode: "url", placeholder: "https://", required: true, autocomplete: "off", spellcheck: "false", "aria-label": "Link" });
  const note = h("input", { class: "input", type: "text", placeholder: "Optional note, e.g. “Episode 4”", maxlength: 80, "aria-label": "Note" });
  const target = h("select", { class: "select", "aria-label": "Send to" });
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { class: "button primary large", type: "submit" }, icon("send"), "Send");
  const form = h("form", { class: "send-form group", novalidate: true },
    h("label", { class: "form-row" }, h("span", { class: "form-label" }, "Link"), url),
    h("label", { class: "form-row" }, h("span", { class: "form-label" }, "Note"), note),
    h("label", { class: "form-row" }, h("span", { class: "form-label" }, "Send to"), target),
    h("div", { class: "form-actions" }, error, submit));
  const waiting = h("div");
  const opened = h("div");
  const page = h("div", { class: "page narrow" }, header, form,
    h("p", { class: "section-footer footnote send-footnote" }, "The link appears in the MP4 Grabber menu on that computer and as a notification. Chrome only lets a download start after a click, so it waits there for you."),
    waiting, opened);
  container.append(page);
  shell.watchTitle(title, "Send to Computer");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    let value = url.value.trim();
    if (value && !/^https?:\/\//i.test(value)) value = `https://${value}`;
    try {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch {
      error.textContent = "Enter a web link starting with http:// or https://.";
      error.hidden = false;
      url.focus();
      return;
    }
    submit.disabled = true;
    try {
      await sendLink({ url: value, note: note.value.trim(), targetDeviceId: target.value });
      url.value = "";
      note.value = "";
      toast(target.value ? `Sent to ${deviceName(target.value)}` : "Sent to your computers");
    } catch (problem) {
      error.textContent = problem.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  function renderTargets() {
    const selected = target.value;
    target.replaceChildren(
      h("option", { value: "" }, state.devices.length > 1 ? "All connected browsers" : state.devices.length ? state.devices[0].name : "Any browser that connects"),
      state.devices.length > 1 ? state.devices.map((device) => h("option", { value: device.id, selected: device.id === selected }, device.name)) : null);
  }

  function itemRow(item, pending) {
    const titleText = item.note || hostOf(item.url) || "Link";
    const subtitle = pending
      ? `${hostOf(item.url)} · sent ${relative(item.createdAt)}${item.targetDeviceId ? ` · to ${deviceName(item.targetDeviceId)}` : ""}`
      : `Opened on ${deviceName(item.openedBy)} ${relative(item.openedAt)}`;
    return h("div", { class: "row" },
      h("div", { class: "tile small" }, icon(pending ? "clock" : "checkCircle")),
      h("div", { class: "row-main" }, h("div", { class: "row-title truncate" }, titleText), h("div", { class: "row-subtitle truncate" }, subtitle)),
      h("button", { class: "button plain destructive", type: "button", "aria-label": `Remove ${titleText}`, onClick: async () => {
        try { await removeLink(item.id); } catch (problem) { toast(problem.message, { error: true }); }
      } }, pending ? "Cancel" : "Remove"));
  }

  function renderLists() {
    const pending = state.inbox.filter((item) => !item.openedAt);
    const done = state.inbox.filter((item) => item.openedAt).slice(0, 10);
    waiting.replaceChildren(pending.length ? h("section", { class: "section" },
      h("div", { class: "section-header" }, h("h2", { class: "section-title" }, "Waiting")),
      h("div", { class: "group" }, pending.map((item) => itemRow(item, true)))) : "");
    opened.replaceChildren(done.length ? h("section", { class: "section" },
      h("div", { class: "section-header" }, h("h2", { class: "section-title" }, "Opened Recently")),
      h("div", { class: "group" }, done.map((item) => itemRow(item, false)))) : "");
    if (!pending.length && !done.length && !state.devices.length) {
      waiting.replaceChildren(emptyState({ iconName: "laptop", title: "No computers connected", message: "Connect MP4 Grabber in Chrome first. Open the extension and choose Connect Library." }));
    }
  }

  const unsubscribe = [on("devices", () => { renderTargets(); renderLists(); }), on("inbox", renderLists)];
  renderTargets();
  renderLists();
  if (!matchMedia("(pointer: coarse)").matches) url.focus();
  return { unmount: () => unsubscribe.forEach((stop) => stop()) };
}
