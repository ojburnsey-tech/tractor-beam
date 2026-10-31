// End-to-end test: the real extension in Chromium, the real server, a real
// HLS stream. Run with `npm run test:e2e` (needs ffmpeg and Playwright).
//
// Optional: `--screenshots <dir>` saves every screen in light, dark and
// phone sizes; `--demo` also loads a spread of past downloads first so the
// Library and Insights screens are populated.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../server/config.js";
import { createApp } from "../../server/app.js";
import { startMediaServer } from "./media-server.js";
import { demoEntries } from "./demo-data.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = path.join(ROOT, "extension");
const args = process.argv.slice(2);
const shotsDir = args.includes("--screenshots") ? path.resolve(args[args.indexOf("--screenshots") + 1]) : null;
const demo = args.includes("--demo");
const EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery staple";

const problems = [];
let step = 0;
function log(message) {
  step += 1;
  console.log(`${String(step).padStart(2, " ")}. ${message}`);
}
function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
}
async function until(fn, { timeout = 20000, interval = 200, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
}

async function shot(page, name, options = {}) {
  if (!shotsDir) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: options.fullPage ?? true });
}

const work = await mkdtemp(path.join(tmpdir(), "grabber-e2e-"));
const media = path.join(work, "media", "hls");
await mkdir(media, { recursive: true });
if (shotsDir) await mkdir(shotsDir, { recursive: true });

log("Encoding a 48-second 720p HLS test stream with ffmpeg");
execFileSync("ffmpeg", [
  "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-t", "48", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "3500k", "-maxrate", "3500k", "-bufsize", "7000k", "-g", "60",
  "-c:a", "aac", "-b:a", "128k", "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
  "-hls_segment_filename", path.join(media, "seg%03d.ts"), path.join(media, "index.m3u8")
]);

const mediaServer = await startMediaServer({ root: path.join(work, "media"), bytesPerSecond: 1_400_000 });
const mediaBase = `http://127.0.0.1:${mediaServer.address().port}`;
const config = loadConfig({ dataDir: path.join(work, "data"), quiet: true, port: 0 });
const app = createApp(config);
const appServer = createServer((req, res) => app.handle(req, res));
await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
const base = `http://localhost:${appServer.address().port}`;

const context = await chromium.launchPersistentContext(path.join(work, "profile"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]
});

function watchErrors(page, label) {
  page.on("pageerror", (error) => problems.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Expected: the browser logs failed requests we provoke on purpose (401 after revoking).
    if (/Failed to load resource|ERR_ABORTED/.test(text)) return;
    problems.push(`${label} console: ${text}`);
  });
}

let exitCode = 0;
try {
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const ext = (file) => `chrome-extension://${extensionId}/${file}`;

  // ---------------------------------------------------------------- sign up
  log("Creating the account on the website");
  const web = await context.newPage();
  watchErrors(web, "website");
  await web.goto(base);
  await web.waitForURL(/\/signup/);
  await shot(web, "web-signup-light");
  await web.fill("#email", EMAIL);
  await web.fill("#password", PASSWORD);
  await web.fill("#confirm", PASSWORD);
  await web.click("button[type=submit]");
  await web.waitForURL(/\/library$/);
  await web.getByText("Connect a browser to begin").waitFor();

  // ---------------------------------------------------------------- pairing
  log("Connecting the extension to the Library (pairing)");
  const linkPage = await context.newPage();
  watchErrors(linkPage, "extension link page");
  await linkPage.goto(ext("link.html"));
  await linkPage.click("#use-server");
  await linkPage.fill("#server-address", base);
  const approvalPagePromise = context.waitForEvent("page", (page) => page.url().startsWith(`${base}/link`));
  await linkPage.click("#connect-button");
  const extensionCode = await until(async () => (await linkPage.textContent("#code"))?.trim(), { label: "pairing code" });
  const approval = await approvalPagePromise;
  watchErrors(approval, "approval page");
  await approval.getByRole("button", { name: "Allow", exact: true }).waitFor();
  const websiteCode = (await approval.textContent(".link-code")).trim();
  check(websiteCode === extensionCode, `pairing codes match (${websiteCode} vs ${extensionCode})`);
  await shot(approval, "web-link-approve-light");
  await approval.getByRole("button", { name: "Allow", exact: true }).click();
  await linkPage.locator("#connected:not([hidden])").waitFor({ timeout: 20000 });
  await shot(linkPage, "ext-link-connected-light");
  const account = await linkPage.evaluate(() => chrome.storage.local.get("account").then((value) => value.account));
  check(account?.server === base && account.email === EMAIL, "extension stored the account");
  const leaked = await linkPage.evaluate(() => chrome.storage.local.get(null).then((all) => JSON.stringify(all)));
  check(!/token|dataKey/i.test(leaked), "token and key are not in chrome.storage (content scripts can read it)");

  // ---------------------------------------------------------------- preferences
  log("Setting synced preferences on the website and pulling them into the extension");
  await web.evaluate(async () => {
    const response = await fetch("/api/me/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Requested-With": "grabber" },
      body: JSON.stringify({ settings: { filenameTemplate: "{title} – {quality}", quality: "720" } })
    });
    if (!response.ok) throw new Error("settings update failed");
  });
  await linkPage.evaluate(() => chrome.runtime.sendMessage({ type: "sync-now" }));
  await until(() => linkPage.evaluate(() => chrome.storage.local.get("account").then((value) => value.account.settings.filenameTemplate === "{title} – {quality}")), { label: "settings to sync" });

  if (demo) {
    log("Loading demo history into the extension and syncing it through the normal path");
    const entries = demoEntries();
    await linkPage.evaluate(async (items) => {
      const store = await import(chrome.runtime.getURL("store.js"));
      for (const entry of items) {
        await store.history.put(entry);
        await store.outbox.add(entry.id);
      }
      await chrome.runtime.sendMessage({ type: "sync-now" });
    }, entries);
    await until(async () => (await web.evaluate(() => fetch("/api/downloads").then((r) => r.json()))).entries.length >= entries.length, { label: "demo history on the server", timeout: 30000 });
  }

  // ---------------------------------------------------------------- detection
  log("Opening the video page and waiting for MP4 Grabber to detect the stream");
  const videoPage = await context.newPage();
  await videoPage.goto(`${mediaBase}/watch.html`);
  const tabId = await linkPage.evaluate(async (url) => (await chrome.tabs.query({ url })).at(0)?.id, `${mediaBase}/watch.html`);
  const streamUrl = `${mediaBase}/hls/index.m3u8`;
  await until(() => linkPage.evaluate(async ({ tabId, streamUrl }) => {
    const stored = await chrome.storage.session.get(`tab:${tabId}`);
    return (stored[`tab:${tabId}`] || []).some((video) => video.url === streamUrl && video.kind === "hls");
  }, { tabId, streamUrl }), { label: "stream detection" });

  // ---------------------------------------------------------------- download
  log("Starting the download and checking preferences were applied");
  const downloadPagePromise = context.waitForEvent("page", (page) => page.url().startsWith(ext("download.html")));
  await linkPage.evaluate(({ url, tabId }) => chrome.runtime.sendMessage({ type: "open-download", url, tabId }), { url: streamUrl, tabId });
  const downloadPage = await downloadPagePromise;
  watchErrors(downloadPage, "download page");
  await downloadPage.locator("#save:not([disabled])").waitFor({ timeout: 30000 });
  const filename = await downloadPage.inputValue("#filename");
  check(filename === "Northern Lights Timelapse – 720p.mp4", `filename template applied (got "${filename}")`);
  const concurrencyLabel = await downloadPage.locator("#concurrency option:checked").textContent();
  check(/Automatic · 3/.test(concurrencyLabel), `smart concurrency shown (got "${concurrencyLabel}")`);
  await shot(downloadPage, "ext-download-ready-light");

  // Chrome's save dialog can't be driven headlessly; save into the origin-private file system instead.
  await downloadPage.evaluate(() => {
    window.showSaveFilePicker = async (options) => (await navigator.storage.getDirectory()).getFileHandle(options.suggestedName.replace(/[^\w.-]+/g, "_"), { create: true });
  });

  const activePage = await context.newPage();
  watchErrors(activePage, "website active");
  await activePage.goto(`${base}/active`);
  await downloadPage.click("#save");

  log("Watching live progress on the website (bridge from this browser)");
  const card = activePage.locator(".job-card").first();
  await card.waitFor({ timeout: 15000 });
  await until(async () => /Northern Lights Timelapse/.test(await card.textContent()), { label: "live card title" });
  await until(() => activePage.evaluate(() => document.querySelector(".connection")?.textContent.includes("this browser is linked")), { label: "bridge connected" });
  await until(async () => (await card.locator(".job-graph svg").count()) > 0, { label: "live speed graph", timeout: 15000 });
  await shot(activePage, "web-active-light");

  log("Pausing from the website through the server (as a phone would)");
  const devices = await activePage.evaluate(() => fetch("/api/devices").then((r) => r.json()));
  const deviceId = devices.devices[0].id;
  const liveJob = await until(async () => {
    const jobs = await activePage.evaluate(() => new Promise((resolve) => {
      const source = new EventSource("/api/events");
      source.addEventListener("live", (event) => { resolve(JSON.parse(event.data).jobs); source.close(); });
    }));
    return jobs.find((job) => job.deviceId === deviceId);
  }, { label: "server live snapshot" });
  check(liveJob.sealed && !liveJob.sealed.includes("Northern"), "live title is encrypted on the server");
  await activePage.evaluate(({ deviceId, jobId }) => fetch("/api/live/command", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "grabber" },
    body: JSON.stringify({ deviceId, jobId, action: "pause" })
  }), { deviceId, jobId: liveJob.jobId });
  await until(async () => (await downloadPage.textContent("#pause")) === "Resume", { label: "download to pause", timeout: 10000 });
  await until(async () => /Paused/.test(await card.textContent()), { label: "website to show paused" });
  await activePage.waitForTimeout(3000);
  await shot(activePage, "web-active-paused-light");

  log("Resuming from the website's button (local bridge)");
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await until(async () => (await downloadPage.textContent("#pause")) === "Pause", { label: "download to resume", timeout: 10000 });
  await shot(downloadPage, "ext-download-progress-light");

  log("Waiting for the download to finish");
  await downloadPage.locator("#status.done").waitFor({ timeout: 90000 });
  await shot(downloadPage, "ext-download-done-light");

  log("Checking the saved file with ffprobe");
  const saved = await downloadPage.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return { name, base64: btoa(binary) };
    }
    return null;
  });
  check(saved, "a file was written");
  const outFile = path.join(work, saved.name);
  await writeFile(outFile, Buffer.from(saved.base64, "base64"));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", outFile]).toString());
  const codecs = probe.streams.map((stream) => stream.codec_name).sort().join("+");
  check(codecs === "aac+h264", `video and audio present (got ${codecs})`);
  check(Math.abs(Number(probe.format.duration) - 48) < 1.5, `full length saved (got ${probe.format.duration}s)`);
  console.log(`    ${saved.name}: ${(Buffer.from(saved.base64, "base64").length / 1e6).toFixed(1)} MB, ${Number(probe.format.duration).toFixed(1)} s, ${codecs}`);

  log("Checking the download arrived in the Library, encrypted at rest");
  await web.goto(`${base}/library`);
  const row = web.locator(".entry-row", { hasText: "Northern Lights Timelapse" }).first();
  await row.waitFor({ timeout: 20000 });
  const db = new DatabaseSync(path.join(config.dataDir, "library.sqlite"), { readOnly: true });
  const stored = db.prepare("SELECT * FROM downloads WHERE state = 'done' ORDER BY finished_at DESC LIMIT 1").get();
  db.close();
  check(stored.sealed.includes('"e":1') && !stored.sealed.includes("Northern") && !stored.sealed.includes("127.0.0.1"), "title and site are encrypted in the database");
  check(stored.height === 720 && stored.kind === "hls" && stored.samples, "numbers and speed samples stored");
  const samples = JSON.parse(stored.samples);
  check(samples.values.some((value) => value === null), "the paused seconds are recorded as a gap");
  check(stored.avg_speed > 0 && stored.peak_speed >= stored.avg_speed * 0.5, "speed summary recorded");
  await shot(web, "web-library-light");

  log("Opening the download's detail sheet");
  await row.click();
  await web.waitForURL(/\/library\/[\w-]+$/);
  const sheet = web.locator(".sheet.open");
  await sheet.waitFor();
  check(await sheet.locator(".series-line").count() > 0, "speed chart drawn");
  const sheetText = await sheet.textContent();
  check(/720p/.test(sheetText) && /H\.264 \+ AAC/.test(sheetText) && /Encrypted/.test(sheetText), "detail facts shown");
  await shot(web, "web-detail-light", { fullPage: false });
  await sheet.getByRole("button", { name: "Show as Table" }).click();
  check(await sheet.locator(".data-table tbody tr").count() > 10, "speed table view");
  await web.keyboard.press("Escape");
  await web.waitForURL(/\/library$/);

  log("Sending a link to this computer from the website");
  await web.goto(`${base}/send`);
  await web.fill('input[type="url"]', `${mediaBase}/watch.html`);
  await web.fill('input[aria-label="Note"]', "Watch later");
  await web.getByRole("button", { name: "Send", exact: true }).click();
  await web.getByText("Waiting").waitFor();
  await linkPage.evaluate(() => chrome.runtime.sendMessage({ type: "sync-now" }));
  const inboxState = await until(async () => {
    const result = await linkPage.evaluate(() => chrome.runtime.sendMessage({ type: "popup-state" }));
    return result.inbox.length ? result : null;
  }, { label: "link to reach the extension" });
  check(inboxState.inbox[0].url === `${mediaBase}/watch.html` && inboxState.inbox[0].note === "Watch later", "link decrypted by the extension");
  await shot(web, "web-send-light");

  log("Checking the popup");
  const popup = await context.newPage();
  watchErrors(popup, "popup");
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(ext("popup.html"));
  await popup.getByText("Sent to this computer").waitFor();
  await popup.getByText("Recent").waitFor();
  await shot(popup, "ext-popup-light");
  await popup.emulateMedia({ colorScheme: "dark" });
  await shot(popup, "ext-popup-dark");
  await popup.close();

  if (shotsDir) {
    log("Capturing every screen in light, dark and phone sizes");
    await web.goto(`${base}/insights`);
    await web.locator(".hero-figure").waitFor();
    await shot(web, "web-insights-light");
    await web.goto(`${base}/settings`);
    await shot(web, "web-settings-light");
    await web.emulateMedia({ colorScheme: "dark" });
    for (const name of ["library", "insights", "settings"]) {
      await web.goto(`${base}/${name}`);
      await web.waitForTimeout(500);
      await shot(web, `web-${name}-dark`);
    }
    const firstRow = web.locator(".entry-row").first();
    await web.goto(`${base}/library`);
    await firstRow.click();
    await web.locator(".sheet.open").waitFor();
    await shot(web, "web-detail-dark", { fullPage: false });
    await web.emulateMedia({ colorScheme: "light" });
    const phone = await context.newPage();
    watchErrors(phone, "phone");
    await phone.setViewportSize({ width: 390, height: 844 });
    for (const name of ["library", "insights", "active", "send", "settings"]) {
      await phone.goto(`${base}/${name}`);
      await phone.waitForTimeout(600);
      await shot(phone, `phone-${name}`, { fullPage: false });
    }
    await phone.goto(`${base}/library`);
    await phone.locator(".entry-row").first().click();
    await phone.locator(".sheet.open").waitFor();
    await phone.waitForTimeout(600);
    await shot(phone, "phone-detail", { fullPage: false });
    await phone.close();
  }

  log("Disconnecting the browser from the website revokes it in the extension");
  await web.goto(`${base}/settings`);
  await web.getByRole("button", { name: "Disconnect" }).click();
  await web.locator(".dialog.open").getByRole("button", { name: "Disconnect" }).click();
  await web.getByText("No browsers connected yet").waitFor();
  await linkPage.evaluate(() => chrome.runtime.sendMessage({ type: "sync-now" }));
  await until(() => linkPage.evaluate(() => chrome.storage.local.get(["account", "disconnected"]).then((value) => !value.account && value.disconnected?.reason === "revoked")), { label: "extension to notice revocation" });

  log("Signing out and back in recovers the encrypted history with the password");
  await web.evaluate(() => fetch("/api/auth/signout", { method: "POST", headers: { "X-Requested-With": "grabber" } }));
  await web.evaluate(() => new Promise((resolve) => { const request = indexedDB.deleteDatabase("grabber-web"); request.onsuccess = request.onerror = request.onblocked = resolve; }));
  await web.goto(`${base}/signin`);
  await web.fill("#email", EMAIL);
  await web.fill("#password", PASSWORD);
  await web.click("button[type=submit]");
  await web.waitForURL(/\/library$/);
  await web.locator(".entry-row", { hasText: "Northern Lights Timelapse" }).first().waitFor();

  if (problems.length) throw new Error(`Errors were logged:\n  ${problems.join("\n  ")}`);
  console.log("\nEnd-to-end test passed.");
} catch (error) {
  exitCode = 1;
  console.error(`\nFAILED at step ${step}: ${error.message}`);
  if (problems.length) console.error(`Logged errors:\n  ${problems.join("\n  ")}`);
} finally {
  await context.close().catch(() => {});
  appServer.closeAllConnections();
  appServer.close();
  app.close();
  mediaServer.closeAllConnections();
  mediaServer.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
