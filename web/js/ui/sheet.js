// Modal sheet. Centred card on wide screens; on phones a bottom sheet you can
// drag down to dismiss, with the release velocity carried into the spring.

import { h, nextFrame, reducedMotion } from "../dom.js";
import { icon } from "../icons.js";
import { spring, project, rubberband } from "./spring.js";

const MOBILE = "(max-width: 699px)";
const stack = [];

export function openSheet({ title, label, content, onClose, wide = false }) {
  const previousFocus = document.activeElement;
  const scrim = h("div", { class: "scrim" });
  const closeButton = h("button", { class: "icon-button", type: "button", "aria-label": "Close", onClick: () => close() }, icon("close"));
  const heading = typeof title === "string" ? h("h2", { class: "title-3", id: "sheet-title" }, title) : title;
  const body = h("div", { class: "sheet-body" }, content);
  const handle = h("div", { class: "sheet-handle", "aria-hidden": "true" });
  const header = h("div", { class: "sheet-header" }, heading, closeButton);
  const sheet = h("div", {
    class: wide ? "sheet wide" : "sheet",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": typeof title === "string" ? "sheet-title" : null,
    "aria-label": label || null,
    tabIndex: -1
  }, handle, header, body);

  let closed = false;
  let animation = null;
  document.body.append(scrim, sheet);
  document.body.style.setProperty("overflow", "hidden");
  stack.push(close);

  nextFrame(() => {
    scrim.classList.add("open");
    sheet.classList.add("open");
    sheet.focus({ preventScroll: true });
  });

  function onKey(event) {
    if (event.key === "Escape" && stack[stack.length - 1] === close) {
      event.preventDefault();
      close();
    }
    if (event.key === "Tab") trapFocus(event, sheet);
  }
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", () => close());

  // ----- drag to dismiss (phones) -----
  let drag = null;
  function offset() {
    const match = /translateY\(([-\d.]+)px\)/.exec(sheet.style.transform);
    return match ? Number(match[1]) : 0;
  }
  function setOffset(value) {
    sheet.style.transform = `translateY(${value}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - value / (sheet.offsetHeight || 1)));
  }
  function onPointerDown(event) {
    if (!window.matchMedia(MOBILE).matches || event.button !== 0) return;
    if (event.target.closest("button, a, input, select, textarea")) return;
    const fromBody = body.contains(event.target);
    if (fromBody && body.scrollTop > 0) return;
    const current = animation ? animation.stop().value : offset();
    animation = null;
    drag = { startY: event.clientY, origin: current, samples: [{ y: event.clientY, t: event.timeStamp }], pointerId: event.pointerId, engaged: !fromBody };
    sheet.style.transition = "none";
  }
  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = event.clientY - drag.startY;
    if (!drag.engaged) {
      if (delta < 8) return;      // let the body scroll unless it's a clear pull down
      drag.engaged = true;
      sheet.setPointerCapture(event.pointerId);
    }
    drag.samples.push({ y: event.clientY, t: event.timeStamp });
    if (drag.samples.length > 6) drag.samples.shift();
    const raw = drag.origin + delta;
    setOffset(raw < 0 ? rubberband(raw, sheet.offsetHeight) : raw);
    event.preventDefault();
  }
  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { samples, engaged } = drag;
    drag = null;
    if (!engaged) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const velocity = last.t > first.t ? ((last.y - first.y) / (last.t - first.t)) * 1000 : 0;
    const position = offset();
    const projected = position + project(velocity);
    if (projected > sheet.offsetHeight * 0.45) close({ velocity });
    else {
      animation = spring({ from: position, to: 0, velocity, response: 0.3, onUpdate: setOffset, onDone: () => { animation = null; } });
    }
  }
  sheet.addEventListener("pointerdown", onPointerDown);
  sheet.addEventListener("pointermove", onPointerMove);
  sheet.addEventListener("pointerup", onPointerUp);
  sheet.addEventListener("pointercancel", onPointerUp);

  function close({ velocity = 0, silent = false } = {}) {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    const index = stack.indexOf(close);
    if (index >= 0) stack.splice(index, 1);
    if (!stack.length) document.body.style.removeProperty("overflow");
    const finish = () => {
      sheet.remove();
      scrim.remove();
    };
    if (window.matchMedia(MOBILE).matches && !reducedMotion()) {
      const from = animation ? animation.stop().value : offset();
      sheet.style.transition = "none";
      scrim.style.transition = "opacity 240ms ease";
      animation = spring({ from, to: sheet.offsetHeight + 40, velocity, response: 0.32, onUpdate: setOffset, onDone: finish });
    } else {
      sheet.classList.add("closing");
      sheet.classList.remove("open");
      scrim.classList.remove("open");
      setTimeout(finish, 260);
    }
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    if (!silent) onClose?.();
  }

  return { close, body, sheet, header };
}

function trapFocus(event, container) {
  const focusable = [...container.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function closeAllSheets() {
  [...stack].reverse().forEach((close) => close({ silent: true }));
}
