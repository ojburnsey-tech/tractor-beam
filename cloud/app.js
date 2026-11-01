import { Router, HttpError, parseCookies, serializeCookie, securityHeaders } from "./http.js";
import { database } from "./db.js";
import { hashToken, newToken } from "./security.js";
import { loadVapid } from "./webpush.js";
import { CloudHub } from "./hub.js";
import { rateLimits } from "./limits.js";
import { registerAuth } from "./routes/auth.js";
import { registerAccount } from "./routes/account.js";
import { registerDownloads } from "./routes/downloads.js";
import { registerDevices } from "./routes/devices.js";
import { registerLink } from "./routes/link.js";
import { registerSync } from "./routes/sync.js";
import { registerLive } from "./routes/live.js";
import { registerInbox } from "./routes/inbox.js";
import { registerPush } from "./routes/push.js";
const COOKIE = "grabber_sid";
const SESSION_MS = 30 * 86400000;
async function readBody(request) {
    if (!request.body)
        return {};
    if (!/^application\/json\b/i.test(request.headers.get("content-type") || ""))
        throw new HttpError(415, "Send JSON.");
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
            await reader.cancel();
            throw new HttpError(413, "That request is too large.");
        }
        chunks.push(value);
    }
    if (!size)
        return {};
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
        return value;
    }
    catch {
        throw new HttpError(400, "The request body isn't valid JSON.");
    }
}
export async function handleApi(request, env, execution) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    const res = { headers, setHeader: (key, value) => headers.set(key, value) };
    const url = new URL(request.url);
    securityHeaders(res, { secure: url.protocol === "https:" });
    const json = (status, value) => {
        headers.set("Content-Type", "application/json; charset=utf-8");
        return new Response(JSON.stringify(value), { status, headers });
    };
    try {
        const db = database(env.DB);
        const hub = new CloudHub(db);
        const config = { allowSignup: false, ownerEmail: String(env.LIBRARY_OWNER_EMAIL || "").toLowerCase(), vapidSubject: env.VAPID_SUBJECT || "https://example.com", sessionDays: 30 };
        const sessions = {
            async create(response, ctx, userId) {
                const token = newToken();
                const now = Date.now();
                await db.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
                    .run(hashToken(token), userId, now, now, now + SESSION_MS, String(request.headers.get("user-agent") || "").slice(0, 300));
                response.setHeader("Set-Cookie", serializeCookie(COOKIE, token, { maxAge: SESSION_MS / 1000, secure: ctx.secure }));
            },
            clear(response, ctx) { response.setHeader("Set-Cookie", serializeCookie(COOKIE, "", { maxAge: 0, secure: ctx.secure })); }
        };
        const router = new Router();
        const deps = { db, hub, config, limits: rateLimits(db), sessions, vapid: null };
        if (url.pathname.startsWith("/api/push/") || url.pathname === "/api/sync/push")
            deps.vapid = await loadVapid(db);
        for (const register of [registerAuth, registerAccount, registerDownloads, registerDevices, registerLink, registerSync, registerLive, registerInbox, registerPush])
            register(router, deps);
        const found = router.match(request.method, url.pathname);
        if (!found)
            throw new HttpError(404, "Not found.");
        if (found.methodNotAllowed)
            throw new HttpError(405, "Method not allowed.");
        const { route, params } = found;
        const auth = route.options.auth || "web";
        const ctx = { request, execution, url, params, secure: url.protocol === "https:", ip: request.headers.get("cf-connecting-ip") || "local", status: 200, body: {} };
        if (["web", "optional"].includes(auth)) {
            let token;
            try {
                token = parseCookies(request.headers.get("cookie") || "")[COOKIE];
            }
            catch {
                throw new HttpError(400, "Invalid cookie.");
            }
            if (token) {
                const session = await db.prepare("SELECT * FROM sessions WHERE id = ?").get(hashToken(token));
                if (session && session.expires_at > Date.now()) {
                    const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
                    if (user) {
                        ctx.user = user;
                        ctx.session = session;
                        if (Date.now() - session.last_seen > 3600000) {
                            await db.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?").run(Date.now(), Date.now() + SESSION_MS, session.id);
                            headers.set("Set-Cookie", serializeCookie(COOKIE, token, { maxAge: SESSION_MS / 1000, secure: ctx.secure }));
                        }
                    }
                }
                else
                    sessions.clear(res, ctx);
            }
            if (!ctx.user && auth === "web")
                throw new HttpError(401, "Sign in to continue.", "signed-out");
        }
        else if (auth === "device") {
            const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") || "");
            const device = match ? await db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(hashToken(match[1])) : null;
            const user = device ? await db.prepare("SELECT * FROM users WHERE id = ?").get(device.user_id) : null;
            if (!device || !user)
                throw new HttpError(401, "This browser is no longer connected.", "device-revoked");
            ctx.device = device;
            ctx.user = user;
            if (Date.now() - device.last_seen > 60000)
                await db.prepare("UPDATE devices SET last_seen = ?, version = ? WHERE id = ?").run(Date.now(), String(request.headers.get("x-extension-version") || device.version).slice(0, 20), device.id);
        }
        const isDeviceLink = auth === "none" && url.pathname.startsWith("/api/link/requests");
        if (!["GET", "HEAD"].includes(request.method) && auth !== "device" && !isDeviceLink) {
            if (request.headers.get("x-requested-with") !== "grabber")
                throw new HttpError(403, "Request blocked.", "csrf");
            const origin = request.headers.get("origin");
            if (origin && origin !== url.origin)
                throw new HttpError(403, "Request blocked.", "csrf");
        }
        if (["POST", "PATCH", "DELETE"].includes(request.method))
            ctx.body = await readBody(request);
        const result = await route.handler(ctx, res);
        if (result instanceof Response)
            return result;
        return json(ctx.status, result ?? { ok: true });
    }
    catch (error) {
        if (!(error instanceof HttpError)) {
            console.error("Library request failed", error?.message || "Unknown error");
            return json(500, { error: "Something went wrong on the server." });
        }
        if (error.extra.retryAfter)
            headers.set("Retry-After", String(error.extra.retryAfter));
        return json(error.status, { error: error.message, code: error.code, ...error.extra });
    }
}
