// Alert-style dialogs. Reserved for decisions that are destructive or
// irreversible; everything else acts immediately.

import { h, nextFrame } from "../dom.js";

function present({ title, message, actions, field, onSubmit }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const scrim = h("div", { class: "scrim", style: { "z-index": "50" } });
    const error = h("p", { class: "dialog-error", role: "alert" });
    const input = field ? h("input", { class: "input", type: field.type || "text", value: field.value || "", placeholder: field.placeholder || "", autocomplete: field.autocomplete || "off", "aria-label": field.label || title }) : null;
    const buttons = actions.map((action) => h("button", {
      type: "button",
      class: [action.default ? "default" : "", action.destructive ? "destructive" : ""].join(" ").trim(),
      onClick: () => choose(action)
    }, action.label));
    const dialog = h("div", { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "dialog-title" },
      h("div", { class: "dialog-body" },
        h("p", { class: "dialog-title", id: "dialog-title" }, title),
        message ? h("p", { class: "dialog-message" }, message) : null,
        input,
        error),
      h("div", { class: "dialog-actions" }, buttons));

    document.body.append(scrim, dialog);
    nextFrame(() => {
      scrim.classList.add("open");
      dialog.classList.add("open");
      (input || buttons.find((_, index) => actions[index].default) || buttons[0]).focus();
    });

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        choose(actions.find((action) => action.cancel) || { value: false });
      } else if (event.key === "Enter" && input && document.activeElement === input) {
        event.preventDefault();
        choose(actions.find((action) => action.default));
      }
    }
    document.addEventListener("keydown", onKey);

    async function choose(action) {
      if (!action) return;
      if (onSubmit && !action.cancel) {
        buttons.forEach((button) => { button.disabled = true; });
        error.textContent = "";
        try {
          await onSubmit(input?.value ?? "");
        } catch (problem) {
          error.textContent = problem.message;
          buttons.forEach((button) => { button.disabled = false; });
          input?.focus();
          input?.select();
          return;
        }
      }
      document.removeEventListener("keydown", onKey);
      dialog.classList.remove("open");
      scrim.classList.remove("open");
      setTimeout(() => { dialog.remove(); scrim.remove(); }, 220);
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(action.cancel ? false : action.value ?? true);
    }
  });
}

export function confirmDialog({ title, message, confirmLabel = "OK", destructive = false }) {
  return present({
    title,
    message,
    actions: [
      { label: "Cancel", cancel: true, value: false },
      { label: confirmLabel, default: !destructive, destructive, value: true }
    ]
  });
}

/** Asks for a line of text, e.g. a new name. Resolves to the text or false. */
export function textDialog({ title, message, value = "", confirmLabel = "Save", placeholder = "" }) {
  let result = value;
  return present({
    title,
    message,
    field: { type: "text", value, placeholder, label: title },
    onSubmit: async (text) => {
      if (!text.trim()) throw new Error("Enter a name.");
      result = text.trim();
    },
    actions: [
      { label: "Cancel", cancel: true },
      { label: confirmLabel, default: true }
    ]
  }).then((ok) => (ok ? result : false));
}

/** Asks for the password, then runs `onSubmit(password)`; errors keep it open. */
export function passwordDialog({ title, message, confirmLabel = "Continue", destructive = false, onSubmit }) {
  return present({
    title,
    message,
    field: { type: "password", placeholder: "Password", autocomplete: "current-password", label: "Password" },
    onSubmit,
    actions: [
      { label: "Cancel", cancel: true },
      { label: confirmLabel, default: true, destructive }
    ]
  });
}
