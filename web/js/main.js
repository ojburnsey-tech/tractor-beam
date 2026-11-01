import { h } from "./dom.js";
import { state, loadSession, start, on } from "./store.js";
import { match, navigate, startRouter } from "./router.js";
import { createShell } from "./views/shell.js";
import { closeAllSheets } from "./ui/sheet.js";
import * as auth from "./views/auth.js";
import * as link from "./views/link.js";
import * as library from "./views/library.js";
import * as active from "./views/active.js";
import * as insights from "./views/insights.js";
import * as send from "./views/send.js";
import * as settings from "./views/settings.js";
import { emptyState } from "./ui/controls.js";
import { applyTheme } from "./theme.js";
const VIEWS = { library, active, insights, send, settings };
const root = document.getElementById("root");
let shell = null;
let current = null;
let started = false;
function unmountCurrent() {
    current?.instance?.unmount?.();
    current = null;
}
function leaveShell() {
    shell?.destroy();
    shell = null;
}
function nextParam() {
    const next = new URLSearchParams(location.search).get("next");
    return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}
async function render() {
    const route = match(location.pathname);
    const here = location.pathname + location.search + location.hash;
    if (!state.user) {
        if (route.access !== "guest") {
            navigate(`/${state.signupOpen ? "signup" : "signin"}${route.name === "home" ? "" : `?next=${encodeURIComponent(here)}`}`, { replace: true });
            return;
        }
        if (route.name === "signin" && state.signupOpen) {
            navigate(`/signup${location.search}`, { replace: true });
            return;
        }
        mountBare(route.name, () => auth.mount(root, { mode: route.name, next: nextParam() }));
        return;
    }
    if (!state.key) {
        if (route.name !== "unlock") {
            navigate(`/unlock?next=${encodeURIComponent(route.access === "app" ? here : "/library")}`, { replace: true });
            return;
        }
        mountBare("unlock", () => auth.mount(root, { mode: "unlock", next: nextParam() }));
        return;
    }
    if (route.access === "guest" || route.name === "unlock" || route.name === "home") {
        navigate(nextParam() || "/library", { replace: true });
        return;
    }
    if (!started) {
        started = true;
        start().catch((error) => console.error(error));
    }
    if (route.bare) {
        mountBare(route.name, () => link.mount(root));
        return;
    }
    if (!shell) {
        unmountCurrent();
        shell = createShell(root);
    }
    shell.setCurrent(route.name);
    document.title = `${route.title} · MP4 Grabber`;
    if (current?.name === route.name && current.instance.update) {
        current.instance.update(route.params);
        return;
    }
    closeAllSheets();
    unmountCurrent();
    const view = VIEWS[route.name];
    shell.main.replaceChildren();
    window.scrollTo(0, 0);
    const instance = view
        ? view.mount(shell.main, route.params, shell)
        : mountMissing(shell.main);
    current = { name: route.name, instance };
}
function mountBare(name, mount) {
    if (current?.name === name)
        return;
    closeAllSheets();
    unmountCurrent();
    leaveShell();
    current = { name, instance: mount() };
}
function mountMissing(container) {
    container.append(h("div", { class: "page" }, emptyState({
        iconName: "info",
        title: "This page doesn't exist",
        message: "The link may be out of date.",
        action: h("a", { class: "button primary", href: "/library" }, "Go to Library")
    })));
    return {};
}
on("session", () => {
    if (!state.user || !state.key) {
        started = false;
        leaveShell();
        unmountCurrent();
    }
    render();
});
applyTheme();
try {
    await loadSession();
}
catch (error) {
    root.replaceChildren(h("div", { class: "auth" }, h("div", { class: "auth-card" }, h("img", { class: "app-icon", src: "/icons/logo.svg?v=2", alt: "" }), h("h1", {}, "Can't reach your Library"), h("p", { class: "lead" }, error.message), h("button", { class: "button primary large", type: "button", onClick: () => location.reload() }, "Try Again"))));
    throw error;
}
if (state.setupRequired) {
    root.replaceChildren(h("div", { class: "auth" }, h("div", { class: "auth-card" }, h("img", { class: "app-icon", src: "/icons/logo.svg?v=2", alt: "" }), h("h1", {}, "Set up your Library"), h("p", { class: "lead" }, "Sign in with the Site owner's ChatGPT account to create your encrypted Library."), h("a", { class: "button primary large", href: "/signin-with-chatgpt?return_to=%2Fsignup", target: "_top" }, "Continue with ChatGPT"))));
}
else
    startRouter(render);
