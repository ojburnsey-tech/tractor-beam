import { createRequire } from "node:module";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const iconDirectory = path.join(root, "web/icons");
const svg = await readFile(path.join(iconDirectory, "logo.svg"), "utf8");
const fullBleed = svg.replace(/rx="228"/g, 'rx="0"').replace(/rx="226"/g, 'rx="0"');
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(process.env.CHROME_NO_SANDBOX === "1" ? { args: ["--no-sandbox"] } : {})
});
const frames = [];
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function render(size, source, name, transparent) {
    await page.setViewportSize({ width: size, height: size });
    const sized = source.replace('width="1024" height="1024"', `width="${size}" height="${size}"`);
    await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
    return page.screenshot({ path: path.join(iconDirectory, name), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  }
  for (const size of [16, 32, 48, 64, 128, 192, 256, 512, 1024]) {
    const png = await render(size, svg, `library-${size}.png`, true);
    if ([16, 32, 48, 64, 128, 256].includes(size)) frames.push({ size, png });
  }
  for (const size of [192, 512]) await render(size, fullBleed, `library-maskable-${size}.png`, false);
  await render(180, fullBleed, "library-apple-touch.png", false);
  for (const [source, target] of [["library-192.png", "icon-192.png"], ["library-512.png", "icon-512.png"], ["library-apple-touch.png", "apple-touch-icon.png"]]) await copyFile(path.join(iconDirectory, source), path.join(iconDirectory, target));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const position = 6 + index * 16;
    header[position] = size === 256 ? 0 : size;
    header[position + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(png.length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += png.length;
  });
  await writeFile(path.join(root, "web/favicon.ico"), Buffer.concat([header, ...frames.map(({ png }) => png)]));
} finally {
  await browser.close();
}
console.log("Rendered Library taskbar, favicon and installable app icons.");
