// A small HTTP toolkit: routing, JSON bodies, cookies, errors, security
// headers and static files. Kept deliberately minimal and dependency-free.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export class HttpError extends Error {
  constructor(status, message, code = undefined, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const MAX_BODY = 1024 * 1024;

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] || "";
    if (!/^application\/json\b/i.test(type)) {
      req.resume();
      reject(new HttpError(415, "Send JSON."));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "That request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!size) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(new HttpError(400, "The request body isn't valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = "Lax", path: cookiePath = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export function securityHeaders(res, { secure }) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

export function sendError(res, error) {
  if (!(error instanceof HttpError)) {
    console.error(error);
    error = new HttpError(500, "Something went wrong on the server.");
  }
  if (error.status === 429 && error.extra.retryAfter) res.setHeader("Retry-After", String(error.extra.retryAfter));
  sendJson(res, error.status, { error: error.message, code: error.code, ...error.extra });
}

/** Path-pattern router: "/api/devices/:id" → params.id. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, options, handler) {
    if (typeof options === "function") [options, handler] = [{}, options];
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/\/:(\w+)/g, (_, key) => { keys.push(key); return "/([^/]+)"; })}$`);
    this.routes.push({ method, regex, keys, options, handler });
  }

  get(pattern, options, handler) { this.add("GET", pattern, options, handler); }
  post(pattern, options, handler) { this.add("POST", pattern, options, handler); }
  patch(pattern, options, handler) { this.add("PATCH", pattern, options, handler); }
  delete(pattern, options, handler) { this.add("DELETE", pattern, options, handler); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, index) => { params[key] = decodeURIComponent(found[index + 1]); });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

/**
 * Serves a file from `root` with an ETag. Returns false when the file doesn't
 * exist so the caller can fall through. Refuses paths that escape `root`.
 */
export async function serveStatic(req, res, root, relative, { cache = "no-cache" } = {}) {
  const resolved = path.resolve(root, "." + path.posix.normalize("/" + relative));
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return false;
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const type = TYPES[path.extname(resolved).toLowerCase()];
  if (!type) return false;
  const etag = `"${createHash("sha1").update(`${info.size}:${info.mtimeMs}`).digest("base64url").slice(0, 16)}"`;
  const headers = { "Content-Type": type, "Cache-Control": cache, ETag: etag };
  if (path.basename(resolved) === "sw.js") headers["Service-Worker-Allowed"] = "/";
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(resolved).pipe(res);
  return true;
}
