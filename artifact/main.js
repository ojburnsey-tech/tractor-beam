// Entry point of the artifact edition: connects to the artifact's database,
// then mounts the same views as the website inside the app frame.

import { h } from "../web/js/dom.js";
import { state, start, on } from "../web/js/store.js";
import { match, startRouter } from "../web/js/router.js";
import { createShell } from "../web/js/views/shell.js";
import { closeAllSheets } from "../web/js/ui/sheet.js";
import { toast } from "../web/js/ui/controls.js";
import * as library from "../web/js/views/library.js";
import * as active from "../web/js/views/active.js";
import * as insights from "../web/js/views/insights.js";
import * as send from "../web/js/views/send.js";
import * as settings from "../web/js/views/settings.js";
import { LOGO_URL } from "../web/js/assets.js";

const VIEWS = { library, active, insights, send, settings };
const root = document.getElementById("root");
let shell = null;
let current = null;

function render() {
  const route = match();
  if (!shell) shell = createShell(root);
  shell.setCurrent(route.name);
  document.title = `${route.title} · MP4 Grabber Library`;
  if (current?.name === route.name && current.instance.update) {
    current.instance.update(route.params);
    return;
  }
  closeAllSheets();
  current?.instance?.unmount?.();
  shell.main.replaceChildren();
  window.scrollTo(0, 0);
  current = { name: route.name, instance: VIEWS[route.name].mount(shell.main, route.params, shell) };
}

function unavailable(reason) {
  const message = {
    outside: "Open this Library from claude.ai or the Claude app. Your history is stored there.",
    "no-db": "This view can't reach your Library's storage. Reload the page, or open it from claude.ai.",
    "signed-out": "Sign in to Claude to open your Library."
  }[reason] || "Your Library can't be opened here.";
  root.replaceChildren(h("div", { class: "auth" }, h("div", { class: "auth-card" },
    h("img", { class: "app-icon", src: LOGO_URL, alt: "", width: 76, height: 76 }),
    h("h1", {}, "MP4 Grabber Library"),
    h("p", { class: "lead" }, message))));
}

root.replaceChildren(h("div", { class: "auth" }, h("p", { class: "lead" }, "Opening your Library…")));
on("write-error", (message) => toast(message, { error: true }));
const result = await start();
if (!result.available) unavailable(result.reason);
else startRouter(render);
