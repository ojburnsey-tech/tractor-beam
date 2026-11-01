// The persistent frame around app pages: sidebar (wide), tab bar (narrow)
// and the compact title bar that appears once the large title scrolls away.

import { h } from "../dom.js";
import { icon } from "../icons.js";
import { state, on, bridge } from "../store.js";

const NAV = [
  { name: "library", href: "/library", label: "Library", icon: "library" },
  { name: "active", href: "/active", label: "Active", icon: "active" },
  { name: "insights", href: "/insights", label: "Insights", icon: "insights" },
  { name: "send", href: "/send", label: "Send", longLabel: "Send to Computer", icon: "send" },
  { name: "settings", href: "/settings", label: "Settings", icon: "settings" }
];

export function createShell(root) {
  const badges = [];
  const links = [];
  const makeLink = (item, long) => {
    const badge = item.name === "active" ? h("span", { class: "badge count", hidden: true, "aria-hidden": "true" }) : null;
    if (badge) badges.push(badge);
    const link = h("a", { href: item.href, dataset: { name: item.name } }, icon(item.icon), h("span", {}, long ? item.longLabel || item.label : item.label), badge);
    links.push(link);
    return link;
  };

  const email = h("span", { class: "account-email truncate" });
  const connection = h("span", { class: "connection" });
  const sidebar = h("aside", { class: "sidebar" },
    h("a", { class: "brand", href: "/library" }, h("img", { src: "/icons/logo.svg?v=2", alt: "", width: 30, height: 30 }), h("span", {}, "MP4 Grabber")),
    h("nav", { class: "nav", "aria-label": "Main" }, NAV.map((item) => makeLink(item, true))),
    h("div", { class: "sidebar-footer" }, email, connection));
  const tabbar = h("nav", { class: "tabbar", "aria-label": "Main" }, NAV.map((item) => makeLink(item, false)));
  const compact = h("div", { class: "compact-bar", "aria-hidden": "true" });
  const main = h("main", { class: "content", id: "main", tabIndex: -1 });
  const frame = h("div", { class: "app" }, sidebar, compact, main, tabbar);
  root.replaceChildren(frame);

  let observer = null;

  function refreshFooter() {
    email.textContent = state.user?.email || "";
    const local = bridge.status.connected;
    connection.className = `connection${state.connection === "live" ? " live" : ""}`;
    connection.textContent = state.connection === "live"
      ? local ? "Live · this browser is linked" : "Live updates on"
      : "Reconnecting…";
  }

  function refreshBadge() {
    const count = state.live.filter((job) => !job.final).length;
    for (const badge of badges) {
      badge.hidden = !count;
      badge.textContent = String(count);
    }
    for (const link of links) {
      if (link.dataset.name === "active") link.setAttribute("aria-label", count ? `Active, ${count} downloading` : "Active");
    }
  }

  const unsubscribe = [on("connection", refreshFooter), on("bridge", refreshFooter), on("live", refreshBadge), on("session", refreshFooter)];
  refreshFooter();
  refreshBadge();

  return {
    main,
    setCurrent(name) {
      for (const link of links) {
        if (link.dataset.name === name) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    /** Shows `title` in the compact bar once `titleElement` scrolls under it. */
    watchTitle(titleElement, title) {
      observer?.disconnect();
      compact.textContent = title;
      compact.classList.remove("visible");
      if (!titleElement) return;
      observer = new IntersectionObserver(([entry]) => {
        compact.classList.toggle("visible", !entry.isIntersecting && entry.boundingClientRect.top < 0);
      }, { rootMargin: "-52px 0px 0px 0px" });
      observer.observe(titleElement);
    },
    destroy() {
      observer?.disconnect();
      unsubscribe.forEach((stop) => stop());
    }
  };
}

/** Standard page header with a large title. Returns { header, title }. */
export function pageHeader(title, { subtitle, actions } = {}) {
  const titleElement = h("h1", { class: "large-title" }, title);
  const subtitleElement = subtitle !== undefined ? h("p", { class: "page-subtitle" }, subtitle) : null;
  const header = h("header", { class: "page-header" }, h("div", {}, titleElement, subtitleElement), actions);
  return { header, title: titleElement, subtitle: subtitleElement };
}
