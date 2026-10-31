// Renders the PNG app icons from web/icons/logo.svg (run once after the logo
// changes): rounded 192/512 for the web manifest, and a full-bleed 180 px
// Apple touch icon (iOS applies its own rounded mask).
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { chromium } = createRequire(import.meta.url)("playwright");
const svg = await readFile(path.join(root, "web/icons/logo.svg"), "utf8");
const fullBleed = svg.replace('<g clip-path="url(#sq)">', "<g>");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, source] of [["icon-192.png", 192, svg], ["icon-512.png", 512, svg], ["apple-touch-icon.png", 180, fullBleed]]) {
  await page.setViewportSize({ width: size, height: size });
  const sized = source.replace(/width="128" height="128"/, `width="${size}" height="${size}"`);
  await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
  await page.screenshot({ path: path.join(root, "web/icons", name), omitBackground: name !== "apple-touch-icon.png", clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log("Rendered web/icons/*.png");
