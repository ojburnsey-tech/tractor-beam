import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, Client } from "./helpers.js";
import * as vault from "../../shared/vault.js";
import { loadConfig } from "../../server/config.js";

let server;
let web;

before(async () => {
  server = await startServer();
  web = new Client(server.base);
  const { authHash, kek } = await vault.deriveAccountKeys("me@example.com", "a long password", 1000);
  await web.post("/api/auth/signup", { email: "me@example.com", authHash, vault: await vault.wrapDataKey(await vault.createDataKey(), kek) });
});

after(() => server.stop());

test("the extension download needs a signed-in session", async () => {
  const anonymous = new Client(server.base);
  assert.equal((await anonymous.get("/api/extension.zip")).status, 401);
});

test("the extension download is a valid zip preset to this Library's address", async () => {
  const response = await fetch(`${server.base}/api/extension.zip`, { headers: { Cookie: web.cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition"), /mp4-grabber-extension-[\d.]+\.zip/);
  const work = await mkdtemp(path.join(tmpdir(), "zip-test-"));
  try {
    const file = path.join(work, "extension.zip");
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    // Python's zipfile checks every CRC and size, independently of our writer.
    const report = JSON.parse(execFileSync("python3", ["-c", `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = z.namelist()
print(json.dumps({"bad": bad, "names": names, "config": json.loads(z.read("MP4 Grabber/config.json")), "manifest": json.loads(z.read("MP4 Grabber/manifest.json"))["name"]}))
`, file]).toString());
    assert.equal(report.bad, null, "every file's checksum is valid");
    assert.ok(report.names.includes("MP4 Grabber/background.js"));
    assert.ok(report.names.includes("MP4 Grabber/vendor/media.js"));
    assert.ok(!report.names.some((name) => name.split("/").some((part) => part.startsWith("."))), "no hidden files");
    assert.deepEqual(report.config, { server: server.base });
    assert.equal(report.manifest, "MP4 Grabber");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a bare email works as the push contact address", () => {
  const original = process.env.VAPID_SUBJECT;
  try {
    process.env.VAPID_SUBJECT = "me@example.com";
    assert.equal(loadConfig().vapidSubject, "mailto:me@example.com");
    process.env.VAPID_SUBJECT = "mailto:me@example.com";
    assert.equal(loadConfig().vapidSubject, "mailto:me@example.com");
    delete process.env.VAPID_SUBJECT;
    assert.equal(loadConfig().vapidSubject, "mailto:owner@localhost");
  } finally {
    if (original === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = original;
  }
});
