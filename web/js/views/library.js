// Library: every download, grouped by day, searchable and filterable.

import { h, debounce } from "../dom.js";
import { icon, kindIcon } from "../icons.js";
import { state, on } from "../store.js";
import { navigate } from "../router.js";
import { emptyState } from "../ui/controls.js";
import { pageHeader } from "./shell.js";
import { openDetail } from "./detail.js";
import { groupByDay, entryTitle, entrySubtitle, filterEntries, sitesOf, TYPE_FILTERS, QUALITY_FILTERS, STATUS_FILTERS } from "../entries.js";
import { formatSize, formatCount } from "/shared/format.js";

const PAGE = 150;
let remembered = { query: "", site: "", type: "", quality: "", status: "" };

function pill(options, value, label, onChange) {
  const select = h("select", { class: `pill-select${value ? " active" : ""}`, "aria-label": label },
    options.map((option) => h("option", { value: option.value, selected: option.value === value }, option.label)));
  select.addEventListener("change", () => {
    select.classList.toggle("active", Boolean(select.value));
    onChange(select.value);
  });
  return select;
}

function entryRow(entry) {
  const stateBadge = ["failed", "cancelled", "partial"].includes(entry.state)
    ? h("span", { class: `state ${entry.state}`, "aria-hidden": "true" }, icon(entry.state === "failed" ? "close" : entry.state === "partial" ? "warning" : "close"))
    : null;
  const time = new Date(entry.finishedAt || entry.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return h("a", { class: "row indent entry-row", href: `/library/${entry.id}`, dataset: { id: entry.id } },
    h("div", { class: "tile" }, icon(kindIcon(entry)), stateBadge),
    h("div", { class: "row-main" },
      h("div", { class: "row-title truncate" }, entryTitle(entry)),
      h("div", { class: `row-subtitle truncate status-text ${entry.state}` }, entrySubtitle(entry))),
    h("div", { class: "row-value caption tabular" }, time),
    h("span", { class: "row-chevron" }, icon("chevron")));
}

export function mount(container, params, shell) {
  const filters = { ...remembered };
  let limit = PAGE;
  let detail = null;
  let detailFromList = false;

  const { header, title, subtitle } = pageHeader("Library", { subtitle: "" });
  const search = h("input", { type: "search", placeholder: "Search titles and sites", value: filters.query, "aria-label": "Search downloads", autocomplete: "off", spellcheck: "false" });
  const clearButton = h("button", { class: "icon-button clear", type: "button", "aria-label": "Clear search", hidden: !filters.query }, icon("close"));
  const siteHost = h("span");
  const toolbar = h("div", { class: "toolbar", role: "search" },
    h("label", { class: "search" }, icon("search"), search, clearButton),
    h("div", { class: "filters" },
      siteHost,
      pill(TYPE_FILTERS, filters.type, "Type", (value) => update({ type: value })),
      pill(QUALITY_FILTERS, filters.quality, "Quality", (value) => update({ quality: value })),
      pill(STATUS_FILTERS, filters.status, "Status", (value) => update({ status: value }))));
  const list = h("div", { class: "library-list" });
  const page = h("div", { class: "page" }, header, toolbar, list);
  container.append(page);
  shell.watchTitle(title, "Library");

  const onSearch = debounce(() => update({ query: search.value }), 120);
  search.addEventListener("input", () => {
    clearButton.hidden = !search.value;
    onSearch();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && search.value) {
      search.value = "";
      clearButton.hidden = true;
      update({ query: "" });
    }
  });
  clearButton.addEventListener("click", () => {
    search.value = "";
    clearButton.hidden = true;
    update({ query: "" });
    search.focus();
  });

  function update(changes) {
    Object.assign(filters, changes);
    remembered = { ...filters };
    limit = PAGE;
    renderList();
  }

  function renderSites() {
    const sites = sitesOf(state.entries);
    if (filters.site && !sites.some((item) => item.site === filters.site)) filters.site = "";
    siteHost.replaceChildren(sites.length > 1 || filters.site
      ? pill([{ value: "", label: "All Sites" }, ...sites.map((item) => ({ value: item.site, label: item.site }))], filters.site, "Site", (value) => update({ site: value }))
      : "");
  }

  function renderSubtitle() {
    const total = state.entries.reduce((sum, entry) => sum + (entry.state === "done" || entry.state === "partial" ? entry.bytes || 0 : 0), 0);
    const count = state.entries.length;
    subtitle.textContent = state.loaded ? (count ? `${formatCount(count)} download${count === 1 ? "" : "s"} · ${formatSize(total)}` : "") : "Loading…";
  }

  function renderList() {
    if (!state.loaded) {
      list.replaceChildren();
      return;
    }
    if (!state.entries.length) {
      const connected = state.devices.length > 0;
      list.replaceChildren(emptyState({
        iconName: "library",
        title: connected ? "No downloads yet" : "Connect a browser to begin",
        message: connected
          ? "Downloads from your connected browsers appear here as soon as they finish, with their speed and details."
          : "Open MP4 Grabber in Chrome, choose Connect Library, and approve it here. Downloads then appear automatically.",
        action: connected ? null : h("a", { class: "button primary", href: "/settings#browsers" }, "How to Connect")
      }));
      toolbar.hidden = true;
      return;
    }
    toolbar.hidden = false;
    const results = filterEntries(state.entries, filters);
    if (!results.length) {
      list.replaceChildren(emptyState({ iconName: "search", title: "No results", message: "Nothing matches these filters. Try a different search or clear a filter." }));
      return;
    }
    const groups = groupByDay(results.slice(0, limit));
    const sections = groups.map((group) => h("section", { class: "section day" },
      h("div", { class: "section-header" }, h("h2", { class: "section-title" }, group.label)),
      h("div", { class: "group" }, group.entries.map(entryRow))));
    if (results.length > limit) {
      sections.push(h("div", { class: "show-more" }, h("button", { class: "button", type: "button", onClick: () => {
        limit += PAGE;
        renderList();
      } }, `Show ${Math.min(PAGE, results.length - limit)} More`)));
    }
    list.replaceChildren(...sections);
  }

  // Remember that the detail was opened from the list so closing goes back.
  list.addEventListener("click", (event) => {
    if (event.target.closest(".entry-row")) detailFromList = true;
  });

  function syncDetail(id) {
    if (!id) {
      detail?.close({ silent: true });
      detail = null;
      return;
    }
    const entry = state.entriesById.get(id);
    if (!entry) {
      if (state.loaded) navigate("/library", { replace: true });
      return;
    }
    if (detail?.entryId === id) return;
    detail?.close({ silent: true });
    detail = openDetail(entry, {
      onClose: () => {
        detail = null;
        if (detailFromList) history.back();
        else navigate("/library", { replace: true });
        detailFromList = false;
      }
    });
    detail.entryId = id;
  }

  let currentId = params.id;
  const render = () => {
    renderSubtitle();
    renderSites();
    renderList();
    syncDetail(currentId);
  };
  const unsubscribe = [on("entries", render), on("devices", renderList)];
  render();

  return {
    update(next) {
      currentId = next.id;
      syncDetail(currentId);
    },
    unmount() {
      unsubscribe.forEach((stop) => stop());
      detail?.close({ silent: true });
    }
  };
}
