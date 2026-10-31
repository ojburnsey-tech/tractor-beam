// Tiny DOM helpers. All text goes in through textContent, never innerHTML,
// so titles and site names from history can't inject markup.

const PROPERTIES = new Set(["value", "checked", "disabled", "hidden", "selected", "indeterminate", "htmlFor", "tabIndex"]);

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function apply(node, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.setAttribute("class", value);
    else if (key === "text") node.textContent = value;
    else if (key === "style") for (const [name, style] of Object.entries(value)) node.style.setProperty(name, style);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "ref") value(node);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (PROPERTIES.has(key)) node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
}

/** h("div", { class: "row", onClick }, child, [children]) */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  apply(node, props);
  return append(node, children);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG element with attributes. */
export function s(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, props);
  return append(node, children);
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** Runs `callback` after the browser has painted the current state. */
export function nextFrame(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

export function debounce(callback, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), wait);
  };
}

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
