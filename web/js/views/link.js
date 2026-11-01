// Approving a browser that asked to connect (opened by the extension at
// /link#r=<request id>). The data key is encrypted to the extension's public
// key here, in the browser; the server never sees it.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { linkRequest, approveLink, declineLink, pairingCode } from "../store.js";

export function mount(root) {
  document.title = "Connect a Browser · MP4 Grabber";
  const id = new URLSearchParams(location.hash.slice(1)).get("r");
  const card = h("div", { class: "auth-card" });
  root.replaceChildren(h("div", { class: "auth" }, card));

  function show(...children) {
    card.replaceChildren(h("img", { class: "app-icon", src: "/icons/logo.svg?v=2", alt: "", width: 76, height: 76 }), ...children);
  }

  function finished(title, message, success) {
    show(
      h("h1", {}, title),
      h("p", { class: "lead" }, message),
      success ? h("p", { class: "link-done" }, icon("checkCircle")) : null,
      h("a", { class: "button primary large wide", href: "/library" }, "Open Library"));
  }

  async function load() {
    if (!id) {
      finished("Nothing to approve", "Open MP4 Grabber in Chrome and choose Connect Library to link a browser.", false);
      return;
    }
    show(h("p", { class: "lead" }, "Loading request…"));
    let request;
    try {
      request = await linkRequest(id);
    } catch (error) {
      finished("This request has expired", error.message, false);
      return;
    }
    const code = await pairingCode(request.publicKey);
    const error = h("p", { class: "auth-error", role: "alert", hidden: true });
    const allow = h("button", { class: "button primary large", type: "button" }, "Allow");
    const deny = h("button", { class: "button large", type: "button" }, "Don't Allow");
    allow.addEventListener("click", async () => {
      allow.disabled = deny.disabled = true;
      allow.textContent = "Connecting…";
      try {
        await approveLink(request);
        finished("Browser connected", `${request.name} will now save its downloads to your Library. You can close this tab.`, true);
      } catch (problem) {
        error.textContent = problem.message;
        error.hidden = false;
        allow.disabled = deny.disabled = false;
        allow.textContent = "Allow";
      }
    });
    deny.addEventListener("click", async () => {
      allow.disabled = deny.disabled = true;
      await declineLink(request.id).catch(() => {});
      finished("Not connected", "The browser wasn't given access. You can close this tab.", false);
    });
    show(
      h("h1", {}, "Connect this browser?"),
      h("p", { class: "lead" }, `${request.name} wants to save its downloads to your Library.`),
      h("div", { class: "group link-details" },
        h("div", { class: "row" }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, "Browser")), h("div", { class: "row-value" }, request.name)),
        request.browser ? h("div", { class: "row" }, h("div", { class: "row-main" }, h("div", { class: "row-title" }, "Details")), h("div", { class: "row-value truncate" }, request.browser)) : null),
      h("p", { class: "link-code tabular", "aria-label": `Pairing code ${code}` }, code),
      h("p", { class: "footnote link-hint" }, "Only allow it if this code matches the one shown in MP4 Grabber."),
      error,
      h("div", { class: "link-actions" }, deny, allow));
  }

  load();
  return {};
}
