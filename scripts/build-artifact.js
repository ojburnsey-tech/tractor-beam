// Builds the Library as a single self-contained claude.ai Artifact page:
// dist/artifact/library.html (content only; the Artifact tool adds the
// document skeleton when it publishes).
//
// The artifact reuses the website's views. Server-specific modules (the
// HTTP store, the history router, the app entry and Settings) are swapped
// for artifact versions that keep data in the artifact's own database.
// ES modules are bundled into one script because an artifact page is
// published as a single file.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "dist", "artifact", "library.html");
const ENTRY = "artifact/main.js";

const OVERRIDES = {
  "web/js/store.js": "artifact/store.js",
  "web/js/bridge.js": "artifact/bridge.js",
  "web/js/router.js": "artifact/router.js",
  "web/js/views/settings.js": "artifact/views/settings.js",
  "web/js/assets.js": "virtual:assets"
};

const CSS = ["web/css/tokens.css", "web/css/base.css", "web/css/components.css", "web/css/shell.css", "web/css/charts.css", "web/css/views.css", "artifact/artifact.css"];

function virtualSource(id) {
  if (id === "virtual:assets") {
    const svg = readFileSync(path.join(ROOT, "web/icons/logo.svg"));
    return `export const LOGO_URL = "data:image/svg+xml;base64,${svg.toString("base64")}";\n`;
  }
  throw new Error(`Unknown virtual module ${id}`);
}

function resolve(specifier, from) {
  let resolved;
  if (specifier.startsWith("/shared/")) resolved = `shared/${specifier.slice("/shared/".length)}`;
  else if (specifier.startsWith(".")) resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  else throw new Error(`${from}: can't bundle bare import "${specifier}"`);
  return OVERRIDES[resolved] || resolved;
}

const IMPORT = /^import\s+(?:(\*\s+as\s+\w+)|\{([^}]*)\})\s+from\s+"([^"]+)";?\s*$/gm;
const EXPORT_DECLARATION = /^export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\};?\s*$/gm;

const modules = new Map();
const order = [];

function load(id) {
  if (modules.has(id)) return;
  const source = id.startsWith("virtual:") ? virtualSource(id) : readFileSync(path.join(ROOT, id), "utf8");
  if (/^\s*import\s*\(/m.test(source) || /\bimport\.meta\b/.test(source)) throw new Error(`${id}: dynamic import and import.meta aren't supported in the artifact bundle`);
  const dependencies = [];
  const exportsList = [];
  let body = source.replace(IMPORT, (whole, namespace, names, specifier) => {
    const target = resolve(specifier, id);
    dependencies.push(target);
    if (namespace) return `const ${namespace.replace(/^\*\s+as\s+/, "")} = __require(${JSON.stringify(target)});`;
    const bindings = names.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const [imported, local] = part.split(/\s+as\s+/);
      return local ? `${imported}: ${local}` : imported;
    });
    return `const { ${bindings.join(", ")} } = __require(${JSON.stringify(target)});`;
  });
  if (/^import\s/m.test(body)) throw new Error(`${id}: an import statement wasn't understood by the bundler`);
  body = body.replace(EXPORT_LIST, (whole, names) => {
    for (const part of names.split(",").map((item) => item.trim()).filter(Boolean)) {
      const [local, exported] = part.split(/\s+as\s+/);
      exportsList.push(exported ? `${exported}: ${local}` : local);
    }
    return "";
  });
  body = body.replace(EXPORT_DECLARATION, (whole, kind, name) => {
    exportsList.push(name);
    return `${kind} ${name}`;
  });
  if (/^export\s/m.test(body)) throw new Error(`${id}: an export statement wasn't understood by the bundler`);
  modules.set(id, { body, exportsList, dependencies, isEntry: id === ENTRY });
  for (const dependency of dependencies) load(dependency);
  order.push(id);
}

load(ENTRY);

const factories = order.map((id) => {
  const module = modules.get(id);
  const keyword = module.isEntry ? "async function" : "function";
  return `__factories[${JSON.stringify(id)}] = ${keyword} (__require) {\n${module.body}\n${module.isEntry ? "" : `return { ${module.exportsList.join(", ")} };`}\n};`;
});

const script = `(() => {
"use strict";
const __factories = {};
const __cache = {};
function __require(id) {
  if (!(id in __cache)) __cache[id] = __factories[id](__require);
  return __cache[id];
}
${factories.join("\n\n")}
__factories[${JSON.stringify(ENTRY)}](__require).catch((error) => {
  console.error(error);
  const root = document.getElementById("root");
  if (root) root.textContent = "The Library couldn't start: " + error.message;
});
})();`;

const css = CSS.map((file) => readFileSync(path.join(ROOT, file), "utf8"))
  .join("\n")
  // The artifact has no server paths: use the system font stack instead of the bundled Inter file.
  .replace(/@font-face\s*\{[^}]*\}/g, "");

const html = `<title>MP4 Grabber Library</title>
<meta name="description" content="Your MP4 Grabber downloads: history, live progress and insights.">
<style>
${css}
</style>
<div id="root"></div>
<script>
${script.replace(/<\/script/gi, "<\\/script")}
</script>
`;

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`Built ${path.relative(ROOT, OUT)} (${(html.length / 1024).toFixed(0)} KB, ${order.length} modules)`);
