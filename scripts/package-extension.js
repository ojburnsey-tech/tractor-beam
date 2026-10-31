// Builds dist/mp4-grabber-extension-<version>.zip, ready to load or share.
// Re-syncs the shared modules first so the package can't ship stale copies.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
execFileSync(process.execPath, [path.join(root, "scripts/sync-shared.js")], { stdio: "inherit" });
const { version } = JSON.parse(readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
mkdirSync(path.join(root, "dist"), { recursive: true });
const output = path.join(root, "dist", `mp4-grabber-extension-${version}.zip`);
rmSync(output, { force: true });
execFileSync("zip", ["-qr", output, ".", "-x", ".*"], { cwd: path.join(root, "extension"), stdio: "inherit" });
console.log(`Packaged ${path.relative(root, output)}`);
