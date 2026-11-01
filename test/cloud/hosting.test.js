import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";
import { build } from "esbuild";
import * as vault from "../../shared/vault.js";
import { hashToken } from "../../cloud/security.js";
const EMAIL = "owner@example.com";
const PASSWORD = "a strong test password";
let worker;
let directory;
let code;
let web;
let device;
let key;
let proof;
function createWorker() {
    return new Miniflare({ modules: true, script: code, compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], d1Persist: directory, bindings: { LIBRARY_OWNER_EMAIL: EMAIL, VAPID_SUBJECT: `mailto:${EMAIL}` }, log: new Log(LogLevel.ERROR) });
}
class Client {
    constructor(token) { this.token = token; this.cookie = ""; }
    async request(method, endpoint, body, headers = {}) {
        headers = { ...headers };
        if (this.cookie)
            headers.Cookie = this.cookie;
        if (this.token)
            headers.Authorization = `Bearer ${this.token}`;
        else if (!["GET", "HEAD"].includes(method))
            headers["X-Requested-With"] ??= "grabber";
        if (body !== undefined)
            headers["Content-Type"] = "application/json";
        const response = await worker.dispatchFetch(`https://library.example${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (response.headers.has("set-cookie"))
            this.cookie = response.headers.get("set-cookie").split(";")[0];
        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        }
        catch { }
        return { status: response.status, json, headers: response.headers, text };
    }
    get(endpoint, headers) { return this.request("GET", endpoint, undefined, headers); }
    post(endpoint, body = {}, headers) { return this.request("POST", endpoint, body, headers); }
    patch(endpoint, body) { return this.request("PATCH", endpoint, body); }
    delete(endpoint) { return this.request("DELETE", endpoint); }
}
async function pair(name = "Test Chrome") {
    const id = vault.randomId(16);
    const secret = vault.randomId(24);
    const keys = await vault.createPairingKeys();
    const guest = new Client();
    const request = await guest.post("/api/link/requests", { id, secretHash: hashToken(secret), publicKey: keys.publicKey, name, browser: "Chrome" });
    assert.equal(request.status, 201, request.text);
    assert.equal((await guest.post(`/api/link/requests/${id}/claim`, { secret })).status, 202);
    const wrappedKey = await vault.sealKeyForDevice(key, keys.publicKey);
    const approvals = await Promise.all([web.post(`/api/link/requests/${id}/approve`, { wrappedKey }), web.post(`/api/link/requests/${id}/approve`, { wrappedKey })]);
    assert.deepEqual(approvals.map((item) => item.status).sort(), [200, 409]);
    const claims = await Promise.all([guest.post(`/api/link/requests/${id}/claim`, { secret }), guest.post(`/api/link/requests/${id}/claim`, { secret })]);
    assert.equal(claims.filter((item) => item.status === 200).length, 1);
    const claimed = claims.find((item) => item.status === 200).json;
    const opened = await vault.openKeyFromWeb(claimed.wrappedKey, keys.privateKey, keys.publicKey);
    assert.equal(await vault.exportDataKey(opened), await vault.exportDataKey(key));
    const client = new Client(claimed.token);
    client.deviceId = claimed.deviceId;
    return client;
}
before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tractor-beam-cloud-"));
    const bundle = await build({ stdin: { contents: 'import { handleApi } from "./cloud/app.js"; export default { fetch: handleApi };', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", write: false });
    code = bundle.outputFiles[0].text;
    worker = createWorker();
    const db = await worker.getD1Database("DB");
    for (const file of (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
        const sql = await readFile(path.join("drizzle", file), "utf8");
        await db.batch(sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
    }
    web = new Client();
    proof = await vault.deriveAccountKeys(EMAIL, PASSWORD);
    key = await vault.createDataKey();
});
after(async () => { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); });
test("only the verified Site owner can create the encrypted Library", async () => {
    const guest = new Client();
    assert.equal((await guest.get("/api/auth/state")).json.setupRequired, true);
    const body = { email: EMAIL, authHash: proof.authHash, vault: await vault.wrapDataKey(key, proof.kek) };
    assert.equal((await guest.post("/api/auth/signup", body)).status, 403);
    assert.equal((await guest.post("/api/auth/signup", body, { "oai-authenticated-user-id": "someone", "oai-authenticated-user-email": "someone@example.com" })).status, 403);
    const created = await web.post("/api/auth/signup", body, { "oai-authenticated-user-id": "owner-id", "oai-authenticated-user-email": EMAIL });
    assert.equal(created.status, 201, created.text);
    assert.match(created.headers.get("set-cookie"), /HttpOnly/);
    assert.match(created.headers.get("set-cookie"), /Secure/);
    assert.equal((await guest.post("/api/auth/signup", body)).status, 403);
    assert.equal((await guest.get("/api/downloads")).status, 401);
    assert.equal((await web.post("/api/auth/signout", {}, { Origin: "https://evil.example" })).status, 403);
});
test("the unchanged extension protocol pairs once and syncs encrypted history", async () => {
    device = await pair();
    const sealed = await vault.seal({ title: "Private test video", site: "example.com", pageUrl: "https://example.com/video" }, { key, encrypt: true, aad: "download_0001" });
    const entry = { id: "download_0001", state: "done", kind: "hls", finishedAt: Date.now(), bytes: 10000, sealed };
    const result = await device.post("/api/sync/push", { entries: [entry, { id: "invalid" }] });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json.accepted, [entry.id]);
    assert.equal(result.json.rejected.length, 1);
    const history = await web.get("/api/downloads");
    assert.equal(history.json.entries.length, 1, history.text);
    assert.equal((await vault.open(history.json.entries[0].sealed, { key, aad: entry.id })).title, "Private test video");
    const db = await worker.getD1Database("DB");
    const stored = await db.prepare("SELECT * FROM downloads").all();
    assert.ok(!JSON.stringify(stored.results).includes("Private test video"));
    assert.equal((await web.patch("/api/me/settings", { settings: { quality: "720", concurrency: 6 } })).status, 200);
    assert.equal((await device.get("/api/sync/pull?since=0")).json.settings.quality, "720");
});
test("history, sessions, live jobs and commands survive Worker restart", async () => {
    const sealed = await vault.seal({ title: "Live video" }, { key, encrypt: true, aad: "live_0001" });
    const pushed = await device.post("/api/live/push", { jobs: [{ jobId: "live_0001", state: "downloading", received: 5000, bytes: 10000, sealed }], ended: [] });
    assert.equal(pushed.status, 200, pushed.text);
    assert.equal((await web.post("/api/live/command", { deviceId: device.deviceId, jobId: "live_0001", action: "pause" })).status, 200);
    await worker.dispose();
    worker = createWorker();
    assert.equal((await web.get("/api/downloads")).json.entries.length, 1);
    const pulled = await device.post("/api/live/push", { jobs: [], ended: [] });
    assert.deepEqual(pulled.json.commands, [{ jobId: "live_0001", action: "pause" }], pulled.text);
    assert.deepEqual((await device.post("/api/live/push", { jobs: [], ended: [] })).json.commands, []);
    const response = await worker.dispatchFetch("https://library.example/api/events", { headers: { Cookie: web.cookie } });
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("event: live"))
        text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /live_0001/);
    await reader.cancel();
});
test("tombstones prevent stale clients restoring downloads and inbox targets are enforced", async () => {
    assert.equal((await web.delete("/api/downloads/download_0001")).status, 200);
    const sealed = await vault.seal({ title: "Old copy" }, { key, encrypt: true, aad: "download_0001" });
    assert.equal((await device.post("/api/sync/push", { entries: [{ id: "download_0001", state: "done", sealed }] })).status, 200);
    assert.equal((await web.get("/api/downloads")).json.entries.length, 0);
    assert.deepEqual((await device.get("/api/sync/pull?since=0")).json.deleted, ["download_0001"]);
    const other = await pair("Other Chrome");
    const inboxSealed = await vault.seal({ url: "https://example.com/video" }, { key, encrypt: true, aad: "inbox_000001" });
    const sent = await web.post("/api/inbox", { id: "inbox_000001", sealed: inboxSealed, targetDeviceId: device.deviceId });
    assert.equal(sent.status, 201, sent.text);
    assert.equal((await other.get("/api/sync/pull?since=0")).json.inbox.length, 0);
    assert.equal((await other.post("/api/inbox/inbox_000001/opened")).status, 200);
    assert.equal((await device.get("/api/sync/pull?since=0")).json.inbox.length, 1);
    await device.post("/api/inbox/inbox_000001/opened");
    assert.equal((await device.get("/api/sync/pull?since=0")).json.inbox.length, 0);
    await web.delete(`/api/devices/${other.deviceId}`);
    assert.equal((await other.get("/api/sync/pull?since=0")).status, 401);
});
test("VAPID keys persist, password changes invalidate other sessions, and deletion clears hosted data", async () => {
    const first = await web.get("/api/push/key");
    assert.equal(first.status, 200, first.text);
    assert.equal((await web.get("/api/push/key")).json.publicKey, first.json.publicKey);
    const otherSession = new Client();
    assert.equal((await otherSession.post("/api/auth/signin", { email: EMAIL, authHash: proof.authHash })).status, 200);
    const next = await vault.deriveAccountKeys(EMAIL, "another strong test password");
    assert.equal((await web.post("/api/me/password", { authHash: proof.authHash, newAuthHash: next.authHash, vault: await vault.wrapDataKey(key, next.kek) })).status, 200);
    assert.equal((await otherSession.get("/api/me")).status, 401);
    assert.equal((await web.post("/api/me/delete", { authHash: next.authHash })).status, 200);
    assert.equal((await device.get("/api/device/me")).status, 401);
    const db = await worker.getD1Database("DB");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM downloads").first()).count, 0);
});
