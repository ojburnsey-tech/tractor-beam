import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startServer, Client } from "./helpers.js";
import * as vault from "../../shared/vault.js";

const ITER = 1000; // fast derivation for tests; the server never sees iterations
const EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery";

let server;
let web;
let dataKey;

async function signUp(client, email = EMAIL, password = PASSWORD) {
  const { authHash, kek } = await vault.deriveAccountKeys(email, password, ITER);
  const key = await vault.createDataKey();
  const response = await client.post("/api/auth/signup", { email, authHash, vault: await vault.wrapDataKey(key, kek) });
  if (response.status === 201) dataKey = key;
  return response;
}

async function linkDevice(name = "Chrome on Mac") {
  const keys = await vault.createPairingKeys();
  const id = vault.randomId(16);
  const secret = vault.randomId(32);
  const secretHash = vault.toBase64Url(await vault.sha256(secret));
  const anon = new Client(server.base);
  assert.equal((await anon.post("/api/link/requests", { id, secretHash, publicKey: keys.publicKey, name, browser: "Chrome 130" })).status, 201);
  const wrappedKey = await vault.sealKeyForDevice(dataKey, keys.publicKey);
  assert.equal((await web.post(`/api/link/requests/${id}/approve`, { wrappedKey })).status, 200);
  const claim = await anon.post(`/api/link/requests/${id}/claim`, { secret });
  assert.equal(claim.status, 200);
  return { device: new Client(server.base, { bearer: claim.json.token }), claim, keys };
}

before(async () => {
  server = await startServer();
  web = new Client(server.base);
});

after(async () => {
  await server.stop();
});

test("sign-up is open for the first account only", async () => {
  assert.equal((await web.get("/api/auth/state")).json.signupOpen, true);
  const created = await signUp(web);
  assert.equal(created.status, 201);
  assert.equal(created.json.user.email, EMAIL);
  assert.match(created.headers.get("set-cookie"), /HttpOnly/);
  const state = await web.get("/api/auth/state");
  assert.equal(state.json.user.email, EMAIL);
  assert.equal(state.json.signupOpen, false);
  const second = await signUp(new Client(server.base), "other@example.com");
  assert.equal(second.status, 403);
});

test("the stored vault unwraps with the password-derived key", async () => {
  const me = await web.get("/api/me");
  const { kek } = await vault.deriveAccountKeys(EMAIL, PASSWORD, ITER);
  const key = await vault.unwrapDataKey(me.json.user.vault, kek);
  assert.equal(await vault.exportDataKey(key), await vault.exportDataKey(dataKey));
});

test("cookie-authenticated writes need the CSRF header and a same-origin Origin", async () => {
  const noHeader = await web.patch("/api/me/settings", { settings: { quality: "720" } }, { "X-Requested-With": "" });
  assert.equal(noHeader.status, 403);
  const foreign = await web.patch("/api/me/settings", { settings: { quality: "720" } }, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const ok = await web.patch("/api/me/settings", { settings: { quality: "720", neverSync: ["example.com"] } }, { Origin: server.base });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.quality, "720");
  assert.deepEqual(ok.json.settings.neverSync, ["example.com"]);
  const invalid = await web.patch("/api/me/settings", { settings: { neverSync: ["not a site!"] } });
  assert.equal(invalid.status, 400);
});

test("sign-in rejects wrong passwords and locks out after repeated failures", async () => {
  const client = new Client(server.base);
  const { authHash } = await vault.deriveAccountKeys(EMAIL, PASSWORD, ITER);
  const { authHash: wrong } = await vault.deriveAccountKeys(EMAIL, "nope", ITER);
  assert.equal((await client.post("/api/auth/signin", { email: EMAIL, authHash: wrong })).status, 401);
  const good = await client.post("/api/auth/signin", { email: EMAIL.toUpperCase(), authHash });
  assert.equal(good.status, 200);
  assert.ok(good.json.user.vault.ct);

  const attacker = new Client(server.base);
  const target = "victim@example.com";
  let last;
  for (let attempt = 0; attempt < 7; attempt += 1) last = await attacker.post("/api/auth/signin", { email: target, authHash: wrong });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
});

test("linking a browser hands over a working token and the data key", async () => {
  const { device, claim, keys } = await linkDevice();
  const received = await vault.openKeyFromWeb(claim.json.wrappedKey, keys.privateKey, keys.publicKey);
  assert.equal(await vault.exportDataKey(received), await vault.exportDataKey(dataKey));
  const me = await device.get("/api/device/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.email, EMAIL);
  const devices = await web.get("/api/devices");
  assert.ok(devices.json.devices.some((item) => item.name === "Chrome on Mac"));
});

test("a link request can't be claimed with the wrong secret, twice, or before approval", async () => {
  const keys = await vault.createPairingKeys();
  const id = vault.randomId(16);
  const secret = vault.randomId(32);
  const anon = new Client(server.base);
  await anon.post("/api/link/requests", { id, secretHash: vault.toBase64Url(await vault.sha256(secret)), publicKey: keys.publicKey, name: "Laptop" });
  assert.equal((await anon.post(`/api/link/requests/${id}/claim`, { secret })).status, 202);
  assert.equal((await anon.post(`/api/link/requests/${id}/claim`, { secret: vault.randomId(32) })).status, 403);
  const info = await web.get(`/api/link/requests/${id}`);
  assert.equal(info.json.name, "Laptop");
  assert.equal(info.json.publicKey, keys.publicKey);
  await web.post(`/api/link/requests/${id}/approve`, { wrappedKey: await vault.sealKeyForDevice(dataKey, keys.publicKey) });
  assert.equal((await anon.post(`/api/link/requests/${id}/claim`, { secret })).status, 200);
  assert.equal((await anon.post(`/api/link/requests/${id}/claim`, { secret })).status, 410, "tokens are handed out once");
});

function makeEntry(id, overrides = {}) {
  return {
    id,
    startedAt: Date.now() - 60000,
    finishedAt: Date.now(),
    state: "done",
    kind: "hls",
    method: "stream",
    mode: "both",
    bytes: 250e6,
    received: 251e6,
    mediaDuration: 600,
    elapsedMs: 60000,
    activeMs: 58000,
    avgSpeed: 4.3e6,
    peakSpeed: 7.9e6,
    height: 1080,
    codecs: "avc1+mp4a",
    container: "mp4",
    fps: 29.97,
    concurrency: 3,
    concurrencyAuto: true,
    samples: { interval: 1000, values: [1e6, 4e6, null, 5e6] },
    ...overrides
  };
}

test("history sync: push, read on the web, delete, and no resurrection", async () => {
  const { device } = await linkDevice("Sync browser");
  const id = vault.randomId(16);
  const sealed = await vault.seal({ title: "Secret Title", site: "example.org" }, { key: dataKey, encrypt: true, aad: id });
  const pushed = await device.post("/api/sync/push", {
    entries: [makeEntry(id, { sealed }), { id: "bad id!", state: "done", sealed }]
  });
  assert.equal(pushed.status, 200);
  assert.deepEqual(pushed.json.accepted, [id]);
  assert.equal(pushed.json.rejected.length, 1);

  const library = await web.get("/api/downloads");
  const stored = library.json.entries.find((item) => item.id === id);
  assert.ok(stored);
  assert.equal(stored.height, 1080);
  assert.deepEqual(stored.samples.values, [1e6, 4e6, null, 5e6]);
  assert.ok(!JSON.stringify(stored).includes("Secret Title"), "the server only has ciphertext");
  assert.deepEqual(await vault.open(stored.sealed, { key: dataKey, aad: id }), { title: "Secret Title", site: "example.org" });

  const cursor = library.json.cursor;
  assert.equal((await web.delete(`/api/downloads/${id}`)).status, 200);
  const pull = await device.get(`/api/sync/pull?since=0`);
  assert.ok(pull.json.deleted.includes(id));
  assert.equal(pull.json.settings.quality, "720");
  const incremental = await web.get(`/api/downloads?since=${cursor}`);
  assert.deepEqual(incremental.json.deleted, [id]);

  await device.post("/api/sync/push", { entries: [makeEntry(id, { sealed })] });
  assert.ok(!(await web.get("/api/downloads")).json.entries.some((item) => item.id === id), "deleted entries stay deleted");
});

test("live progress reaches the website and commands reach the device", async () => {
  const { device } = await linkDevice("Live browser");
  const events = await fetch(`${server.base}/api/events`, { headers: { Cookie: web.cookie } });
  assert.equal(events.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value } = await reader.read();
      buffer += decoder.decode(value);
      if (predicate(buffer)) return true;
    }
    return false;
  };

  const me = await device.get("/api/device/me");
  await device.post("/api/live/push", { jobs: [{ jobId: "job-1", state: "busy", fraction: 0.4, speed: 5e6, recent: [1e6, 2e6], canPause: true }] });
  assert.ok(await waitFor((text) => text.includes('"jobId":"job-1"') && text.includes('"fraction":0.4')));

  const command = await web.post("/api/live/command", { deviceId: me.json.device.id, jobId: "job-1", action: "pause" });
  assert.equal(command.status, 200);
  const next = await device.post("/api/live/push", { jobs: [{ jobId: "job-1", state: "paused", paused: true }] });
  assert.deepEqual(next.json.commands, [{ jobId: "job-1", action: "pause" }]);
  const empty = await device.post("/api/live/push", { ended: ["job-1"] });
  assert.deepEqual(empty.json.commands, []);
  assert.equal((await web.post("/api/live/command", { deviceId: me.json.device.id, jobId: "job-1", action: "pause" })).status, 404);
  await reader.cancel();
});

test("send to computer: targeted links reach only that browser", async () => {
  const { device: first } = await linkDevice("First");
  const { device: second } = await linkDevice("Second");
  const firstId = (await first.get("/api/device/me")).json.device.id;
  const id = vault.randomId(16);
  const sealed = await vault.seal({ url: "https://example.com/watch" }, { key: dataKey, encrypt: true, aad: id });
  assert.equal((await web.post("/api/inbox", { id, sealed, targetDeviceId: firstId })).status, 201);
  assert.ok((await first.get("/api/sync/pull")).json.inbox.some((item) => item.id === id));
  assert.ok(!(await second.get("/api/sync/pull")).json.inbox.some((item) => item.id === id));
  await first.post(`/api/inbox/${id}/opened`);
  assert.ok(!(await first.get("/api/sync/pull")).json.inbox.some((item) => item.id === id));
  const listed = (await web.get("/api/inbox")).json.items.find((item) => item.id === id);
  assert.equal(listed.openedBy, firstId);
});

test("disconnecting a browser revokes its token", async () => {
  const { device } = await linkDevice("Doomed");
  const id = (await device.get("/api/device/me")).json.device.id;
  assert.equal((await web.delete(`/api/devices/${id}`)).status, 200);
  const after = await device.get("/api/sync/pull");
  assert.equal(after.status, 401);
  assert.equal(after.json.code, "device-revoked");
});

test("push subscriptions only accept real push services", async () => {
  const keys = { p256dh: vault.toBase64Url(new Uint8Array(65).fill(4)), auth: vault.toBase64Url(new Uint8Array(16)) };
  const evil = await web.post("/api/push/subscriptions", { subscription: { endpoint: "http://169.254.169.254/latest", keys } });
  assert.equal(evil.status, 400);
  const good = await web.post("/api/push/subscriptions", { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }, label: "Phone" });
  assert.equal(good.status, 201);
  assert.equal((await web.get("/api/push/key")).json.publicKey.length, 87);
});

test("changing the password keeps the data key and signs out other sessions", async () => {
  const other = new Client(server.base);
  const { authHash, kek } = await vault.deriveAccountKeys(EMAIL, PASSWORD, ITER);
  await other.post("/api/auth/signin", { email: EMAIL, authHash });
  assert.equal((await other.get("/api/me")).status, 200);

  const next = await vault.deriveAccountKeys(EMAIL, "a brand new password", ITER);
  const current = await vault.unwrapDataKey((await web.get("/api/me")).json.user.vault, kek);
  const changed = await web.post("/api/me/password", { authHash, newAuthHash: next.authHash, vault: await vault.wrapDataKey(current, next.kek) });
  assert.equal(changed.status, 200);
  assert.equal((await other.get("/api/me")).status, 401);
  const me = await web.get("/api/me");
  const rewrapped = await vault.unwrapDataKey(me.json.user.vault, next.kek);
  assert.equal(await vault.exportDataKey(rewrapped), await vault.exportDataKey(dataKey));
});

test("static files: the app shell, shared modules, security headers, no traversal", async () => {
  const home = await web.get("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /text\/html/);
  assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.equal((await web.get("/library/abc")).status, 200, "client routes fall back to the app");
  assert.equal((await web.get("/shared/vault.js")).status, 200);
  assert.equal((await web.get("/shared/../server/db.js")).status, 404);
  assert.equal((await web.get("/%2e%2e/server/db.js")).status, 404);
  assert.equal((await web.get("/nope.js")).status, 404);
  assert.equal((await web.get("/api/nope")).status, 404);
});

test("signing out ends the session", async () => {
  assert.equal((await web.post("/api/auth/signout")).status, 200);
  assert.equal((await web.get("/api/me")).status, 401);
  const hash = createHash("sha256").update("x").digest("hex");
  assert.ok(hash);
});
