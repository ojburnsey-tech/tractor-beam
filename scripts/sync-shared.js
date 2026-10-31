// Copies shared/*.js into extension/lib/ so the extension (which can only load
// files inside its own folder) uses byte-identical code to the website.
// test/unit/shared-sync.test.js fails if the copies drift.

import { readdir, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "shared");
const target = path.join(root, "extension", "lib");

await mkdir(target, { recursive: true });
const files = (await readdir(source)).filter((name) => name.endsWith(".js"));
for (const name of files) await copyFile(path.join(source, name), path.join(target, name));
console.log(`Copied ${files.length} shared modules into extension/lib/`);
