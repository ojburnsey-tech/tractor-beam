// Small reusable controls: toast, switch, segmented control, grouped rows.

import { h } from "../dom.js";
import { icon } from "../icons.js";

let toastHost = null;

export function toast(message, { error = false } = {}) {
  toastHost ||= document.body.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const item = h("div", { class: `toast${error ? " error" : ""}` }, icon(error ? "failed" : "checkCircle"), message);
  toastHost.append(item);
  setTimeout(() => {
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 220);
  }, error ? 4200 : 2400);
}

export function toggle({ checked, label, onChange, disabled = false }) {
  const input = h("input", { type: "checkbox", role: "switch", checked, disabled, "aria-label": label });
  input.addEventListener("change", () => onChange(input.checked, input));
  return h("label", { class: "switch" }, input, h("span"));
}

/** iOS segmented control with a sliding thumb. */
export function segmented({ options, value, label, onChange }) {
  const thumb = h("span", { class: "thumb", "aria-hidden": "true" });
  const root = h("div", { class: "segmented", role: "group", "aria-label": label }, thumb);
  const buttons = options.map((option) => h("button", {
    type: "button",
    "aria-pressed": String(option.value === value),
    onClick: () => select(option.value, true)
  }, option.label));
  root.append(...buttons);

  function place() {
    const index = options.findIndex((option) => option.value === value);
    const target = buttons[index];
    if (!target || !target.offsetWidth) return;
    thumb.style.width = `${target.offsetWidth}px`;
    thumb.style.transform = `translateX(${target.offsetLeft}px)`;
  }

  function select(next, notify) {
    value = next;
    buttons.forEach((button, index) => button.setAttribute("aria-pressed", String(options[index].value === value)));
    place();
    if (notify) onChange?.(value);
  }

  new ResizeObserver(place).observe(root);
  return Object.assign(root, { select: (next) => select(next, false) });
}

/** A grouped-list row. Pass `href` or `onClick` to make it interactive. */
export function row({ title, subtitle, value, leading, trailing, href, onClick, chevron, className = "", external = false }) {
  const tag = href ? "a" : onClick ? "button" : "div";
  const props = { class: `row ${className}`.trim() };
  if (href) {
    props.href = href;
    if (external) { props.target = "_blank"; props.rel = "noreferrer"; }
  }
  if (onClick) {
    if (tag === "button") props.type = "button";
    props.onClick = onClick;
  }
  return h(tag, props,
    leading,
    h("div", { class: "row-main" },
      title instanceof Node ? title : h("div", { class: "row-title" }, title),
      subtitle ? (subtitle instanceof Node ? subtitle : h("div", { class: "row-subtitle" }, subtitle)) : null),
    value !== undefined && value !== null ? (value instanceof Node ? value : h("div", { class: "row-value" }, value)) : null,
    trailing,
    chevron ? h("span", { class: "row-chevron" }, icon(external ? "external" : "chevron")) : null);
}

export function section({ title, footer, children, action, large = false, className = "" }) {
  return h("section", { class: `section ${className}`.trim() },
    title || action ? h("div", { class: "section-header" }, title ? h("h2", { class: `section-title${large ? " large" : ""}` }, title) : h("span"), action) : null,
    h("div", { class: "group" }, children),
    footer ? h("p", { class: "section-footer footnote" }, footer) : null);
}

export function emptyState({ iconName, title, message, action }) {
  return h("div", { class: "empty" }, icon(iconName), h("h2", {}, title), h("p", {}, message), action);
}

export function spinner() {
  return h("span", { class: "spinner", "aria-hidden": "true" });
}
