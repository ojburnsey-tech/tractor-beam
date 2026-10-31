// Serves the Chrome extension as a zip, pre-set to this Library's address, so
// installing it needs no GitHub, no terminal and no typing of the address.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../config.js";
import { HttpError } from "../http.js";
import { createZip } from "../zip.js";

const SOURCE = path.join(ROOT, "extension");
const FOLDER = "MP4 Grabber";
const cache = new Map(); // origin → { zip, version }

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(full, relative));
    else if (entry.isFile()) files.push({ full, relative });
  }
  return files;
}

async function build(origin) {
  const manifest = JSON.parse(await readFile(path.join(SOURCE, "manifest.json"), "utf8"));
  const files = [];
  for (const file of await listFiles(SOURCE)) {
    const info = await stat(file.full);
    const data = file.relative === "config.json"
      ? Buffer.from(`${JSON.stringify({ server: origin }, null, 2)}\n`)
      : await readFile(file.full);
    files.push({ name: `${FOLDER}/${file.relative}`, data, modified: info.mtime });
  }
  return { zip: createZip(files), version: manifest.version };
}

export function registerExtension(router, { config }) {
  router.get("/api/extension.zip", async (ctx, res) => {
    let source;
    try {
      await stat(path.join(SOURCE, "manifest.json"));
      source = true;
    } catch {
      source = false;
    }
    if (!source) throw new HttpError(404, "This server was deployed without the extension folder.");
    const host = (config.trustProxy && ctx.req.headers["x-forwarded-host"]) || ctx.req.headers.host;
    const origin = `${ctx.secure ? "https" : "http"}://${host}`;
    if (!cache.has(origin)) cache.set(origin, await build(origin));
    const { zip, version } = cache.get(origin);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": zip.length,
      "Content-Disposition": `attachment; filename="mp4-grabber-extension-${version}.zip"`,
      "Cache-Control": "no-store"
    });
    res.end(zip);
  });
}
