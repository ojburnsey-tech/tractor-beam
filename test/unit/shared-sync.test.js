import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// The extension can only load files inside its own folder, so shared modules
// are copied into extension/lib by `npm run sync-shared`. They must match.
test("extension/lib is an exact copy of shared/", async () => {
  const shared = (await readdir(new URL("../../shared/", import.meta.url))).filter((name) => name.endsWith(".js"));
  for (const name of shared) {
    const source = await readFile(new URL(`../../shared/${name}`, import.meta.url), "utf8");
    const copy = await readFile(new URL(`../../extension/lib/${name}`, import.meta.url), "utf8").catch(() => null);
    assert.equal(copy, source, `extension/lib/${name} is out of date. Run: npm run sync-shared`);
  }
});
