// Builds the request handler: API routing with per-route authentication,
// CSRF protection for cookie sessions, and static files for the website.

import path from "node:path";
import { Router, HttpError, readJson, parseCookies, serializeCookie, securityHeaders, sendJson, sendError, serveStatic } from "./http.js";
import { openDatabase } from "./db.js";
import { hashToken, newToken, RateLimiter } from "./security.js";
import { loadVapid } from "./webpush.js";
import { LiveHub } from "./live-hub.js";
import { ROOT } from "./config.js";
import { registerAuth } from "./routes/auth.js";
import { registerAccount } from "./routes/account.js";
import { registerDownloads } from "./routes/downloads.js";
import { registerDevices } from "./routes/devices.js";
import { registerLink } from "./routes/link.js";
import { registerSync } from "./routes/sync.js";
import { registerLive } from "./routes/live.js";
import { registerInbox } from "./routes/inbox.js";
import { registerPush } from "./routes/push.js";
import { registerExtension } from "./routes/extension.js";

export const SESSION_COOKIE = "grabber_sid";
const WEB_ROOT = path.join(ROOT, "web");
const SHARED_ROOT = path.join(ROOT, "shared");

export function createApp(config) {
  const db = openDatabase(config.dataDir);
  const hub = new LiveHub();
  const vapid = loadVapid(db);
  const router = new Router();
  const limits = {
    signinIp: new RateLimiter({ limit: 20, windowMs: 15 * 60 * 1000 }),
    signinEmail: new RateLimiter({ limit: 6, windowMs: 15 * 60 * 1000, lockMs: 60 * 1000 }),
    signup: new RateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 }),
    link: new RateLimiter({ limit: 20, windowMs: 60 * 60 * 1000 }),
    password: new RateLimiter({ limit: 6, windowMs: 15 * 60 * 1000, lockMs: 60 * 1000 })
  };
  const sessionMs = config.sessionDays * 86400000;

  const sessions = {
    create(res, ctx, userId) {
      const token = newToken();
      const now = Date.now();
      db.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
        .run(hashToken(token), userId, now, now, now + sessionMs, String(ctx.req.headers["user-agent"] || "").slice(0, 300));
      res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, token, { maxAge: sessionMs / 1000, secure: ctx.secure }));
    },
    clear(res, ctx) {
      res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: ctx.secure }));
    }
  };

  const deps = { db, hub, config, vapid, limits, sessions };
  for (const register of [registerAuth, registerAccount, registerDownloads, registerDevices, registerLink, registerSync, registerLive, registerInbox, registerPush, registerExtension]) {
    register(router, deps);
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || "unknown";
  }

  function isSecure(req) {
    if (req.socket.encrypted) return true;
    return config.trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  }

  /** The host the browser addressed (the proxy's, when one is trusted). */
  function requestHost(req) {
    return String((config.trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "").toLowerCase();
  }

  /**
   * Compares hosts rather than full origins: a TLS-terminating proxy (Caddy,
   * Tailscale Serve) makes the browser's https:// origin arrive as plain HTTP.
   */
  function sameOrigin(origin, req) {
    try {
      return new URL(origin).host.toLowerCase() === requestHost(req);
    } catch {
      return false;
    }
  }

  function webAuth(req, res, ctx) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(hashToken(token));
    const now = Date.now();
    if (!session || session.expires_at < now) {
      if (session) db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      sessions.clear(res, ctx);
      return null;
    }
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
    if (!user) return null;
    // Rolling expiry, refreshed at most hourly to avoid a write per request.
    if (now - session.last_seen > 3600000) {
      db.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?").run(now, now + sessionMs, session.id);
      res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, token, { maxAge: sessionMs / 1000, secure: ctx.secure }));
    }
    return { user, session };
  }

  function deviceAuth(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || "");
    if (!match) return null;
    const device = db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(hashToken(match[1]));
    if (!device) return null;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(device.user_id);
    if (!user) return null;
    const now = Date.now();
    if (now - device.last_seen > 60000) {
      const version = String(req.headers["x-extension-version"] || device.version).slice(0, 20);
      db.prepare("UPDATE devices SET last_seen = ?, version = ? WHERE id = ?").run(now, version, device.id);
    }
    return { user, device };
  }

  async function handleApi(req, res, ctx) {
    const found = router.match(req.method, ctx.url.pathname);
    if (!found) throw new HttpError(404, "Not found.");
    if (found.methodNotAllowed) throw new HttpError(405, "Method not allowed.");
    const { route, params } = found;
    const auth = route.options.auth || "web";
    ctx.params = params;

    if (auth === "web" || auth === "optional") {
      const result = webAuth(req, res, ctx);
      if (!result && auth === "web") throw new HttpError(401, "Sign in to continue.", "signed-out");
      Object.assign(ctx, result || {});
      if (req.method !== "GET" && req.method !== "HEAD") {
        // Cross-site requests can't set custom headers without a CORS
        // preflight, which this server never approves.
        if (req.headers["x-requested-with"] !== "grabber") throw new HttpError(403, "Request blocked.", "csrf");
        const origin = req.headers.origin;
        if (origin && !sameOrigin(origin, req)) throw new HttpError(403, "Request blocked.", "csrf");
      }
    } else if (auth === "device") {
      const result = deviceAuth(req);
      if (!result) throw new HttpError(401, "This browser is no longer connected.", "device-revoked");
      Object.assign(ctx, result);
    }

    if (["POST", "PATCH", "DELETE"].includes(req.method)) {
      const hasBody = Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"];
      ctx.body = hasBody ? await readJson(req) : {};
    } else {
      ctx.body = {};
    }
    const result = await route.handler(ctx, res);
    if (result !== undefined && !res.headersSent) sendJson(res, ctx.status || 200, result);
  }

  async function handleStatic(req, res, ctx) {
    if (!["GET", "HEAD"].includes(req.method)) throw new HttpError(405, "Method not allowed.");
    const pathname = decodeURIComponent(ctx.url.pathname);
    if (pathname.startsWith("/shared/")) {
      if (await serveStatic(req, res, SHARED_ROOT, pathname.slice("/shared/".length))) return;
      throw new HttpError(404, "Not found.");
    }
    if (pathname !== "/" && await serveStatic(req, res, WEB_ROOT, pathname.slice(1))) return;
    // Application routes (no file extension) all load the single-page app.
    if (pathname === "/" || !path.extname(pathname)) {
      await serveStatic(req, res, WEB_ROOT, "index.html");
      return;
    }
    throw new HttpError(404, "Not found.");
  }

  async function handle(req, res) {
    const secure = isSecure(req);
    securityHeaders(res, { secure });
    const ctx = { req, res, secure, ip: clientIp(req), status: 0 };
    try {
      ctx.url = new URL(req.url, "http://localhost");
      if (ctx.url.pathname.startsWith("/api/")) await handleApi(req, res, ctx);
      else await handleStatic(req, res, ctx);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, error);
    }
    if (!config.quiet && ctx.url && ctx.url.pathname.startsWith("/api/") && res.statusCode >= 500) {
      console.error(`${req.method} ${ctx.url.pathname} → ${res.statusCode}`);
    }
  }

  function close() {
    hub.close();
    db.close();
  }

  return { handle, close, db, hub, deps };
}
