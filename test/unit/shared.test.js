import { test } from "node:test";
import assert from "node:assert/strict";
import * as vault from "../../shared/vault.js";
import { cleanPageUrl, siteOf, normalizeSitePattern, hostMatches } from "../../shared/privacy.js";
import { renderFilename, sanitizeFilename } from "../../shared/template.js";
import { classifyError, explain, ERROR_CODES } from "../../shared/explain.js";
import { recommendConcurrency } from "../../shared/concurrency.js";
import { formatSize, formatSpeed, formatClock, formatRemaining } from "../../shared/format.js";

// A low iteration count keeps the suite fast; the scheme is identical.
const FAST = 1000;

test("account keys: same password derives the same auth hash; a different one does not", async () => {
  const a = await vault.deriveAccountKeys("Me@Example.com ", "correct horse", FAST);
  const b = await vault.deriveAccountKeys("me@example.com", "correct horse", FAST);
  const c = await vault.deriveAccountKeys("me@example.com", "wrong horse", FAST);
  assert.equal(a.authHash, b.authHash, "email is normalised before use as salt");
  assert.notEqual(a.authHash, c.authHash);
  assert.match(a.authHash, /^[A-Za-z0-9_-]{43}$/);
});

test("data key wraps with the password and refuses a wrong password", async () => {
  const { kek } = await vault.deriveAccountKeys("me@example.com", "pw-1", FAST);
  const { kek: wrong } = await vault.deriveAccountKeys("me@example.com", "pw-2", FAST);
  const dataKey = await vault.createDataKey();
  const wrapped = await vault.wrapDataKey(dataKey, kek);
  const unwrapped = await vault.unwrapDataKey(wrapped, kek);
  assert.equal(await vault.exportDataKey(unwrapped), await vault.exportDataKey(dataKey));
  await assert.rejects(vault.unwrapDataKey(wrapped, wrong), (error) => error.code === "wrong-password");
});

test("sealed records round-trip, are bound to their id, and plain mode is readable", async () => {
  const key = await vault.createDataKey();
  const data = { title: "Northern Lights", site: "vimeo.com" };
  const sealed = await vault.seal(data, { key, encrypt: true, aad: "entry-1" });
  assert.ok(vault.isEncrypted(sealed));
  assert.ok(!sealed.includes("Northern"), "ciphertext must not contain the title");
  assert.deepEqual(await vault.open(sealed, { key, aad: "entry-1" }), data);
  await assert.rejects(vault.open(sealed, { key, aad: "entry-2" }), (error) => error.code === "undecryptable");
  await assert.rejects(vault.open(sealed, { key: null, aad: "entry-1" }), (error) => error.code === "locked");
  const plain = await vault.seal(data, { encrypt: false });
  assert.ok(!vault.isEncrypted(plain));
  assert.deepEqual(await vault.open(plain, {}), data);
});

test("pairing hands the data key to the extension and nobody else", async () => {
  const dataKey = await vault.createDataKey();
  const device = await vault.createPairingKeys();
  const intruder = await vault.createPairingKeys();
  const payload = await vault.sealKeyForDevice(dataKey, device.publicKey);
  const received = await vault.openKeyFromWeb(payload, device.privateKey, device.publicKey);
  assert.equal(await vault.exportDataKey(received), await vault.exportDataKey(dataKey));
  await assert.rejects(vault.openKeyFromWeb(payload, intruder.privateKey, intruder.publicKey));
  const code = await vault.pairingCode(device.publicKey);
  assert.match(code, /^[2-9A-Z]{3}-[2-9A-Z]{3}$/);
  assert.equal(code, await vault.pairingCode(device.publicKey));
});

test("base64url handles large buffers and rejects junk", () => {
  const bytes = vault.randomBytes(100000);
  assert.deepEqual(vault.fromBase64Url(vault.toBase64Url(bytes)), bytes);
  assert.throws(() => vault.fromBase64Url("not base64!"));
});

test("cleanPageUrl strips credentials, tokens and tracking, keeps content ids", () => {
  assert.equal(
    cleanPageUrl("https://user:pw@www.youtube.com/watch?v=abc123&utm_source=x&token=secret&si=share#t=10"),
    "https://www.youtube.com/watch?v=abc123"
  );
  assert.equal(cleanPageUrl("https://cdn.example.com/v.mp4?Expires=1&Signature=abc&Key-Pair-Id=K"), "https://cdn.example.com/v.mp4");
  assert.equal(cleanPageUrl(`https://a.com/p?id=7&blob=${"x".repeat(80)}`), "https://a.com/p?id=7");
  assert.equal(cleanPageUrl("chrome://settings"), "");
  assert.equal(cleanPageUrl("not a url"), "");
});

test("site patterns and matching", () => {
  assert.equal(siteOf("https://www.BBC.co.uk/iplayer"), "bbc.co.uk");
  assert.equal(normalizeSitePattern(" https://WWW.Example.com/path "), "example.com");
  assert.equal(normalizeSitePattern("example"), "");
  assert.equal(normalizeSitePattern("localhost"), "localhost");
  assert.ok(hostMatches("video.example.com", ["example.com"]));
  assert.ok(hostMatches("www.example.com", ["example.com"]));
  assert.ok(!hostMatches("notexample.com", ["example.com"]));
});

test("filename templates drop empty tokens with their separators", () => {
  const when = new Date(2026, 9, 31, 21, 40);
  assert.equal(renderFilename("{site} – {title} – {quality}", { title: "Clip", site: "vimeo.com", quality: "1080p" }, when), "vimeo.com – Clip – 1080p");
  assert.equal(renderFilename("{title} – {quality}", { title: "Clip" }, when), "Clip");
  assert.equal(renderFilename("{quality} - {title}", { title: "Clip" }, when), "Clip");
  assert.equal(renderFilename("{title} {date}", { title: "A/B: C?" }, when), "A_B_ C_ 2026-10-31");
  assert.equal(renderFilename("{nope}", { title: "T" }, when), "{nope}");
  assert.equal(renderFilename("", {}, when), "video");
  assert.equal(sanitizeFilename("CON.mp4"), "_CON.mp4");
});

test("errors are classified into codes with explanations", () => {
  assert.equal(classifyError("The server returned HTTP 403. Reload the video page, press play and try the fresh link."), "expired");
  assert.equal(classifyError("The server returned HTTP 404."), "not-found");
  assert.equal(classifyError("Download cancelled. Check the stream again to restart."), "cancelled");
  assert.equal(classifyError("anything", { protected: true }), "drm");
  assert.equal(classifyError(new TypeError("Failed to fetch")), "network");
  assert.equal(classifyError("The selected tracks could not be copied without losing media."), "codec");
  assert.equal(classifyError("No complete media track was found. Select the master playlist rather than an individual fragment."), "fragment");
  assert.equal(classifyError("Something odd"), "unknown");
  for (const code of ERROR_CODES) {
    const text = explain(code);
    assert.ok(text.title && text.detail && text.fix, code);
  }
});

test("smart concurrency: default, exploration, choice and tie-breaking", () => {
  const entry = (concurrency, mbps) => ({ site: "a.com", state: "done", method: "stream", concurrency, bytes: 100e6, activeMs: 60e3, avgSpeed: mbps * 1e6 });
  assert.equal(recommendConcurrency([], "a.com").level, 3);
  const onlyThree = recommendConcurrency([entry(3, 5)], "a.com");
  assert.equal(onlyThree.level, 6);
  assert.ok(onlyThree.exploring);
  const sixFaster = recommendConcurrency([entry(3, 5), entry(6, 9), entry(6, 8)], "a.com");
  assert.equal(sixFaster.level, 6);
  assert.ok(!sixFaster.exploring);
  const tie = recommendConcurrency([entry(3, 9.5), entry(6, 10)], "a.com");
  assert.equal(tie.level, 3, "a lower level within 8% wins");
  const sixSlower = recommendConcurrency([entry(3, 9), entry(6, 4)], "a.com");
  assert.equal(sixSlower.level, 3);
  const ignored = recommendConcurrency([{ ...entry(6, 50), bytes: 1e6 }], "a.com");
  assert.equal(ignored.level, 3, "small downloads are not evidence");
});

test("formatting", () => {
  assert.equal(formatSize(1_400_000_000), "1.4 GB");
  assert.equal(formatSize(532_000), "532 KB");
  assert.equal(formatSize(0), "0 KB");
  assert.equal(formatSpeed(7_300_000), "7.3 MB/s");
  assert.equal(formatClock(75), "1:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatRemaining(200), "About 3 minutes left");
});
