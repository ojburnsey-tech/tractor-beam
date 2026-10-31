// Router for the artifact. Artifact links only carry a plain "#name", so
// app paths map to hash names: /library ↔ #library, /library/<id> ↔
// #d-<id>, /settings ↔ #preferences ("settings" is reserved by claude.ai).
// Views keep using ordinary "/path" links; clicks on them are handled here.

const ROUTES = [
  { name: "library", pattern: /^\/library(?:\/([A-Za-z0-9-]+))?$/, keys: ["id"], title: "Library" },
  { name: "active", pattern: /^\/active$/, title: "Active" },
  { name: "insights", pattern: /^\/insights$/, title: "Insights" },
  { name: "send", pattern: /^\/send$/, title: "Send to Computer" },
  { name: "settings", pattern: /^\/settings$/, title: "Settings" }
];

let current = "/library";
let fragment = null;
let listener = () => {};

function toHash(pathname) {
  if (pathname.startsWith("/library/")) return `d-${pathname.slice("/library/".length)}`;
  if (pathname === "/settings") return "preferences";
  return pathname.slice(1) || "library";
}

function fromHash(hash) {
  const name = String(hash || "").replace(/^#/, "");
  if (name.startsWith("d-") && /^[A-Za-z0-9-]+$/.test(name.slice(2))) return `/library/${name.slice(2)}`;
  if (name === "preferences" || name === "browsers") return "/settings";
  if (["library", "active", "insights", "send"].includes(name)) return `/${name}`;
  return "/library";
}

export function currentPath() {
  return current;
}

/** The "#part" of the last link followed, e.g. "browsers" from /settings#browsers. */
export function currentFragment() {
  return fragment;
}

export function match(pathname = current) {
  for (const route of ROUTES) {
    const found = route.pattern.exec(pathname);
    if (!found) continue;
    const params = {};
    (route.keys || []).forEach((key, index) => { params[key] = found[index + 1] || null; });
    return { ...route, access: "app", params };
  }
  return { ...ROUTES[0], access: "app", params: {} };
}

function writeHash(hash, replace) {
  try {
    if (replace) location.replace(`#${hash}`);
    else location.hash = hash;
  } catch {
    // Some frames refuse URL changes; the in-memory route still works.
  }
}

export function navigate(path, { replace = false } = {}) {
  const [pathname, part] = String(path).split("#");
  const next = fromHash(toHash(pathname || "/library"));
  fragment = part || null;
  if (next === current && !part) return;
  current = next;
  writeHash(toHash(current), replace);
  listener();
}

export function back() {
  navigate("/library", { replace: true });
}

export function startRouter(onChange) {
  listener = onChange;
  current = fromHash(location.hash);
  if (location.hash === "#browsers") fragment = "browsers";
  window.addEventListener("hashchange", () => {
    const next = fromHash(location.hash);
    if (next === current) return;
    current = next;
    listener();
  });
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest("a[href]");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href.startsWith("/") || href.startsWith("//")) return;
    event.preventDefault();
    navigate(href);
  });
  listener();
}
