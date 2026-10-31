// End-to-end test of the ARTIFACT edition: the real extension in Chromium,
// the built Library page in a sandboxed cross-origin frame (see
// artifact-host.js), a real HLS stream. `npm run test:artifact`
// Optional: `--screenshots <dir>`.

import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startArtifactHost } from "./artifact-host.js";
import { startMediaServer } from "./media-server.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = path.join(ROOT, "extension");
const args = process.argv.slice(2);
const shotsDir = args.includes("--screenshots") ? path.resolve(args[args.indexOf("--screenshots") + 1]) : null;
const BASE = "data/users/mock-user-1";

const problems = [];
let step = 0;
const log = (message) => console.log(`${String(++step).padStart(2, " ")}. ${message}`);
const check = (condition, message) => { if (!condition) throw new Error(`Check failed: ${message}`); };
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
async function shot(page, name, fullPage = false) {
  if (!shotsDir) return;
  await page.waitForTimeout(800); // let sheets and charts finish animating
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage });
}
function watchErrors(page, label) {
  page.on("pageerror", (error) => problems.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource|ERR_ABORTED|net::ERR/.test(message.text())) problems.push(`${label} console: ${message.text()}`);
  });
}
const frameOf = async (page) => until(() => page.frames().find((frame) => frame.url().includes("/frame/library.html")), { label: "artifact frame" });

const work = await mkdtemp(path.join(tmpdir(), "grabber-artifact-e2e-"));
const media = path.join(work, "media", "hls");
await mkdir(media, { recursive: true });
if (shotsDir) await mkdir(shotsDir, { recursive: true });

log("Building the artifact page");
execFileSync(process.execPath, [path.join(ROOT, "scripts/build-artifact.js")], { stdio: "inherit" });

log("Encoding a 40-second 720p HLS test stream");
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  "-t", "40", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "3500k", "-maxrate", "3500k", "-bufsize", "7000k", "-g", "60", "-c:a", "aac", "-b:a", "128k",
  "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(media, "seg%03d.ts"), path.join(media, "index.m3u8")]);

const host = await startArtifactHost({ pagePath: path.join(ROOT, "dist/artifact/library.html") });
const mediaServer = await startMediaServer({ root: path.join(work, "media"), bytesPerSecond: 1_300_000 });
const mediaBase = `http://127.0.0.1:${mediaServer.address().port}`;
const context = await chromium.launchPersistentContext(path.join(work, "profile"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]
});

let exitCode = 0;
let phoneBrowser = null;
try {
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const ext = (file) => `chrome-extension://${extensionId}/${file}`;
  const extPage = await context.newPage();
  watchErrors(extPage, "extension page");
  await extPage.goto(ext("link.html"));
  await extPage.locator("#connect:not([hidden])").waitFor();
  await shot(extPage, "ext-link-start");

  log("Opening the Library artifact (sandboxed cross-origin frame)");
  const desktop = await context.newPage();
  watchErrors(desktop, "desktop library");
  await desktop.goto(host.hostUrl("preferences"));
  let frame = await frameOf(desktop);
  await frame.getByRole("button", { name: "Connect This Browser" }).waitFor({ timeout: 15000 });
  await shot(desktop, "artifact-settings-unpaired");

  log("Pairing: the Library asks, MP4 Grabber confirms with a matching code");
  const pairTabPromise = context.waitForEvent("page", (page) => page.url().startsWith(ext("link.html?pair=")));
  await frame.getByRole("button", { name: "Connect This Browser" }).click();
  const pairTab = await pairTabPromise;
  watchErrors(pairTab, "pair tab");
  await pairTab.locator("#pair:not([hidden])").waitFor();
  const extensionCode = (await pairTab.textContent("#pair-code")).trim();
  const libraryCode = (await until(async () => (await frame.locator(".pair-code").textContent().catch(() => ""))?.trim(), { label: "code in the Library" }));
  check(extensionCode && extensionCode === libraryCode, `codes match (${extensionCode} / ${libraryCode})`);
  await shot(pairTab, "ext-pair-confirm");
  await pairTab.fill("#pair-name", "Chrome on Test Mac");
  await pairTab.click("#pair-confirm");
  await pairTab.locator("#connected:not([hidden])").waitFor();
  await frame.getByText("This browser is connected").waitFor({ timeout: 15000 });
  const device = await until(() => [...host.docs.entries()].find(([key]) => key.startsWith(`${BASE}/library/devices/`)), { label: "device saved in the Library" });
  check(device[1].name === "Chrome on Test Mac", "device name stored");
  const account = await extPage.evaluate(() => chrome.storage.local.get("account").then((value) => value.account));
  check(account.mode === "artifact" && account.origin === host.frameOrigin, `extension linked to the artifact origin (${account.origin})`);
  await shot(desktop, "artifact-settings-paired");

  log("Preferences set in the Library reach the extension");
  await frame.locator("select[aria-label='Default quality']").selectOption("720");
  const template = frame.locator(".template-input");
  await template.fill("{title} – {quality}");
  await template.blur();
  await until(() => extPage.evaluate(() => chrome.storage.local.get("account").then((value) => value.account.settings.filenameTemplate === "{title} – {quality}" && value.account.settings.quality === "720")), { label: "settings to reach the extension" });

  log("A phone (a separate browser, no extension) opens the same Library on Active");
  phoneBrowser = await chromium.launch();
  const phone = await (await phoneBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  watchErrors(phone, "phone library");
  await phone.goto(host.hostUrl("active"));
  const phoneFrame = await frameOf(phone);
  await phoneFrame.getByText("Nothing downloading").waitFor();

  log("Detecting and downloading a stream");
  const videoPage = await context.newPage();
  await videoPage.goto(`${mediaBase}/watch.html`);
  const tabId = await extPage.evaluate(async (url) => (await chrome.tabs.query({ url })).at(0)?.id, `${mediaBase}/watch.html`);
  const streamUrl = `${mediaBase}/hls/index.m3u8`;
  await until(() => extPage.evaluate(async ({ tabId, streamUrl }) => ((await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] || []).some((video) => video.url === streamUrl), { tabId, streamUrl }), { label: "stream detection" });
  const downloadPagePromise = context.waitForEvent("page", (page) => page.url().startsWith(ext("download.html")));
  await extPage.evaluate(({ url, tabId }) => chrome.runtime.sendMessage({ type: "open-download", url, tabId }), { url: streamUrl, tabId });
  const downloadPage = await downloadPagePromise;
  watchErrors(downloadPage, "download page");
  await downloadPage.locator("#save:not([disabled])").waitFor({ timeout: 30000 });
  check((await downloadPage.inputValue("#filename")) === "Northern Lights Timelapse – 720p.mp4", "filename template from the Library applied");
  await downloadPage.evaluate(() => {
    window.showSaveFilePicker = async (options) => (await navigator.storage.getDirectory()).getFileHandle(options.suggestedName.replace(/[^\w.-]+/g, "_"), { create: true });
  });
  await downloadPage.click("#save");

  log("The phone sees live progress relayed by the computer's Library");
  const phoneCard = phoneFrame.locator(".job-card").first();
  await phoneCard.waitFor({ timeout: 20000 });
  await until(async () => /Northern Lights Timelapse/.test(await phoneCard.textContent()), { label: "relayed title on the phone" });
  check(/Chrome on Test Mac/.test(await phoneCard.textContent()), "the phone names the computer doing the download");
  await until(async () => (await phoneCard.locator(".job-graph svg").count()) > 0, { label: "relayed speed graph", timeout: 15000 });
  await shot(phone, "artifact-phone-active");

  log("Pausing and resuming from the phone");
  await phoneCard.getByRole("button", { name: "Pause", exact: true }).click();
  await until(async () => (await downloadPage.textContent("#pause")) === "Resume", { label: "download to pause", timeout: 15000 });
  await until(async () => /Paused/.test(await phoneCard.textContent()), { label: "phone to show paused", timeout: 15000 });
  await phone.waitForTimeout(2500);
  await phoneCard.getByRole("button", { name: "Resume", exact: true }).click();
  await until(async () => (await downloadPage.textContent("#pause")) === "Pause", { label: "download to resume", timeout: 15000 });

  log("Download finishes and is saved to the Library");
  await downloadPage.locator("#status.done").waitFor({ timeout: 90000 });
  const saved = await downloadPage.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return { name, base64: btoa(binary) };
    }
    return null;
  });
  const outFile = path.join(work, saved.name);
  await writeFile(outFile, Buffer.from(saved.base64, "base64"));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name", "-of", "json", outFile]).toString());
  check(probe.streams.map((stream) => stream.codec_name).sort().join("+") === "aac+h264" && Math.abs(Number(probe.format.duration) - 40) < 1.5, "saved file is complete");
  const entry = await until(() => [...host.docs.entries()].find(([key, value]) => key.startsWith(`${BASE}/library/downloads/`) && value.title === "Northern Lights Timelapse")?.[1], { label: "entry in the Library database" });
  check(entry.height === 720 && entry.samples?.values?.some((value) => value === null) && entry.deviceId === account.deviceId, "entry has quality, pause gap and device");
  const outbox = await extPage.evaluate(async () => (await import(chrome.runtime.getURL("store.js"))).outbox.ids());
  check(outbox.length === 0, "the extension's outbox emptied after the Library confirmed");

  log("Library and detail sheet show it");
  await desktop.goto(host.hostUrl("library"));
  frame = await frameOf(desktop);
  const row = frame.locator(".entry-row", { hasText: "Northern Lights Timelapse" }).first();
  await row.waitFor({ timeout: 15000 });
  await shot(desktop, "artifact-library");
  await row.click();
  await frame.locator(".sheet.open .series-line").first().waitFor();
  await shot(desktop, "artifact-detail");
  await desktop.keyboard.press("Escape");

  log("Sending a link from the phone reaches this computer");
  await phone.goto(host.hostUrl("send"));
  const phoneSend = await frameOf(phone);
  await phoneSend.fill('input[type="url"]', `${mediaBase}/watch.html`);
  await phoneSend.fill('input[aria-label="Note"]', "Watch later");
  await phoneSend.getByRole("button", { name: "Send", exact: true }).click();
  const inboxState = await until(async () => {
    const result = await extPage.evaluate(() => chrome.runtime.sendMessage({ type: "popup-state" }));
    return result.inbox.length ? result : null;
  }, { label: "link to reach the extension" });
  check(inboxState.inbox[0].note === "Watch later", "link received by the extension");
  await shot(phone, "artifact-phone-send");

  log("Export from the Library (through the viewer's save prompt)");
  await desktop.goto(host.hostUrl("preferences"));
  frame = await frameOf(desktop);
  await frame.getByText("Export as JSON").click();
  const files = await until(() => frame.evaluate(() => window.__savedFiles), { label: "export file" });
  check(JSON.parse(files[0].text).some((item) => item.title === "Northern Lights Timelapse"), "export contains the download");

  log("Disconnecting the browser from the phone revokes the extension");
  await phone.goto(host.hostUrl("preferences"));
  const phoneSettings = await frameOf(phone);
  await phoneSettings.getByRole("button", { name: "Disconnect" }).click();
  await phoneSettings.locator(".dialog.open").getByRole("button", { name: "Disconnect" }).click();
  await until(() => extPage.evaluate(() => chrome.storage.local.get(["account", "disconnected"]).then((value) => !value.account && value.disconnected?.reason === "revoked")), { label: "extension to be revoked", timeout: 25000 });

  if (problems.length) throw new Error(`Errors were logged:\n  ${problems.join("\n  ")}`);
  console.log("\nArtifact end-to-end test passed.");
} catch (error) {
  exitCode = 1;
  console.error(`\nFAILED at step ${step}: ${error.message}`);
  if (problems.length) console.error(`Logged errors:\n  ${problems.join("\n  ")}`);
} finally {
  await context.close().catch(() => {});
  await phoneBrowser?.close().catch(() => {});
  host.server.closeAllConnections();
  host.server.close();
  mediaServer.closeAllConnections();
  mediaServer.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
