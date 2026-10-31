// History-API router. Same-origin links are handled in place; everything
// else (new tabs, modified clicks, downloads, external links) is left alone.

const ROUTES = [
  { name: "home", pattern: /^\/$/ },
  { name: "signin", pattern: /^\/signin$/, access: "guest" },
  { name: "signup", pattern: /^\/signup$/, access: "guest" },
  { name: "unlock", pattern: /^\/unlock$/, access: "locked" },
  { name: "link", pattern: /^\/link$/, access: "app", bare: true },
  { name: "library", pattern: /^\/library(?:\/([A-Za-z0-9_-]+))?$/, access: "app", keys: ["id"], title: "Library" },
  { name: "active", pattern: /^\/active$/, access: "app", title: "Active" },
  { name: "insights", pattern: /^\/insights$/, access: "app", title: "Insights" },
  { name: "send", pattern: /^\/send$/, access: "app", title: "Send to Computer" },
  { name: "settings", pattern: /^\/settings$/, access: "app", title: "Settings" }
];

let listener = () => {};

export function match(pathname = location.pathname) {
  for (const route of ROUTES) {
    const found = route.pattern.exec(pathname);
    if (!found) continue;
    const params = {};
    (route.keys || []).forEach((key, index) => { params[key] = found[index + 1] || null; });
    return { ...route, params };
  }
  return { name: "missing", access: "app", params: {}, title: "Not Found" };
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search + location.hash) return;
  history[replace ? "replaceState" : "pushState"](null, "", path);
  listener();
}

export function startRouter(onChange) {
  listener = onChange;
  window.addEventListener("popstate", () => listener());
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest("a[href]");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  listener();
}
