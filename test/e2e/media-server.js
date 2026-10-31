// A stand-in "video site" for end-to-end tests: one page that plays an HLS
// stream, served with bandwidth throttling so downloads take long enough to
// observe live progress, pause and resume.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4", ".html": "text/html; charset=utf-8" };

export const WATCH_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Northern Lights Timelapse</title></head>
<body style="font-family:system-ui;background:#111;color:#eee">
<h1>Northern Lights Timelapse</h1>
<video controls width="640"></video>
<script>fetch("/hls/index.m3u8").then((r) => r.text());</script>
</body></html>`;

/** Sends in 32 KB chunks, sharing one bandwidth budget across all responses. */
function sendThrottled(server, res, buffer) {
  const chunk = 32 * 1024;
  let offset = 0;
  const pump = () => {
    if (res.destroyed) return;
    const end = Math.min(buffer.length, offset + chunk);
    res.write(buffer.subarray(offset, end));
    const cost = ((end - offset) / server.bytesPerSecond) * 1000;
    offset = end;
    if (offset >= buffer.length) {
      res.end();
      return;
    }
    const now = Date.now();
    server.nextSlot = Math.max(server.nextSlot || now, now) + cost;
    setTimeout(pump, Math.max(0, server.nextSlot - now));
  };
  pump();
}

export async function startMediaServer({ root, port = 0, bytesPerSecond = 2_000_000 }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/watch.html") {
      res.writeHead(200, { "Content-Type": TYPES[".html"] });
      res.end(WATCH_PAGE);
      return;
    }
    const file = path.join(root, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      await stat(file);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = await readFile(file);
    const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Accept-Ranges": "bytes" };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    let status = 200;
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
      body = body.subarray(start, end + 1);
      status = 206;
    }
    headers["Content-Length"] = body.length;
    res.writeHead(status, headers);
    if (req.method === "HEAD") { res.end(); return; }
    if (path.extname(file) === ".ts") sendThrottled(server, res, body);
    else res.end(body);
  });
  server.bytesPerSecond = bytesPerSecond;
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}
