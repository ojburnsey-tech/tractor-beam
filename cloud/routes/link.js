import { HttpError } from "../http.js";
import { hashToken, newId, newToken, safeEqual } from "../security.js";
import * as validate from "../validate.js";
const LIFETIME_MS = 10 * 60 * 1000;
const MAX_CLAIMS = 800;
const B64URL = /^[A-Za-z0-9_-]+$/;
export function registerLink(router, { db, hub, limits }) {
    const purge = async () => await db.prepare("DELETE FROM link_requests WHERE expires_at < ?").run(Date.now());
    async function pending(id) {
        await purge();
        const row = await db.prepare("SELECT * FROM link_requests WHERE id = ?").get(id);
        if (!row)
            throw new HttpError(404, "This connection request has expired. Start again from the extension.", "expired");
        return row;
    }
    router.post("/api/link/requests", { auth: "none" }, async (ctx) => {
        await limits.link.hit(ctx.ip);
        await purge();
        const body = ctx.body;
        const id = validate.string(body.id, { min: 16, max: 64, pattern: validate.ID, name: "Request id" });
        const secretHash = validate.string(body.secretHash, { min: 43, max: 43, pattern: B64URL, name: "Secret" });
        const publicKey = validate.string(body.publicKey, { min: 87, max: 87, pattern: B64URL, name: "Public key" });
        const name = validate.string(String(body.name || "").trim(), { min: 1, max: 60, name: "Browser name" });
        const browser = validate.string(String(body.browser || ""), { max: 120, name: "Browser" });
        if (await db.prepare("SELECT 1 FROM link_requests WHERE id = ?").get(id))
            throw new HttpError(409, "Request id in use.");
        const now = Date.now();
        await db.prepare(`INSERT INTO link_requests (id, secret_hash, public_key, name, browser, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, secretHash, publicKey, name, browser, now, now + LIFETIME_MS);
        ctx.status = 201;
        return { expiresAt: now + LIFETIME_MS };
    });
    router.get("/api/link/requests/:id", async (ctx) => {
        const row = await pending(ctx.params.id);
        return {
            id: row.id,
            name: row.name,
            browser: row.browser,
            publicKey: row.public_key,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            status: row.status
        };
    });
    router.post("/api/link/requests/:id/approve", async (ctx) => {
        const row = await pending(ctx.params.id);
        if (row.status !== "pending")
            throw new HttpError(409, "This request was already answered.");
        const key = ctx.body.wrappedKey;
        if (!key || typeof key !== "object")
            throw validate.bad("The encryption key is missing.");
        const wrappedKey = JSON.stringify({
            v: 1,
            epk: validate.string(key.epk, { min: 87, max: 87, pattern: B64URL, name: "Key" }),
            salt: validate.string(key.salt, { min: 22, max: 22, pattern: B64URL, name: "Key" }),
            iv: validate.string(key.iv, { min: 16, max: 16, pattern: B64URL, name: "Key" }),
            ct: validate.string(key.ct, { min: 40, max: 80, pattern: B64URL, name: "Key" })
        });
        const deviceId = newId();
        const token = newToken();
        const now = Date.now();
        const result = await db.batch([
            db.prepare(`INSERT INTO devices (id, user_id, name, browser, token_hash, created_at, last_seen)
                SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM link_requests WHERE id = ? AND status = 'pending' AND expires_at > ?)`)
                .statement(deviceId, ctx.user.id, row.name, row.browser, hashToken(token), now, now, row.id, now),
            db.prepare("UPDATE link_requests SET status = 'approved', user_id = ?, device_id = ?, token = ?, wrapped_key = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
                .statement(ctx.user.id, deviceId, token, wrappedKey, row.id, now)
        ]);
        if (!result[0].meta.changes)
            throw new HttpError(409, "This request was already answered or expired.");
        await hub.emit(ctx.user.id, "devices", {});
        return { deviceId };
    });
    router.post("/api/link/requests/:id/decline", async (ctx) => {
        const row = await pending(ctx.params.id);
        if (row.status === "pending")
            await db.prepare("UPDATE link_requests SET status = 'declined' WHERE id = ? AND status = 'pending'").run(row.id);
        return { ok: true };
    });
    router.post("/api/link/requests/:id/claim", { auth: "none" }, async (ctx) => {
        await purge();
        const row = await db.prepare("SELECT * FROM link_requests WHERE id = ?").get(ctx.params.id);
        if (!row)
            throw new HttpError(410, "This connection request has expired.", "expired");
        const secret = validate.string(ctx.body.secret, { min: 20, max: 100, pattern: B64URL, name: "Secret" });
        await db.prepare("UPDATE link_requests SET claim_attempts = claim_attempts + 1 WHERE id = ?").run(row.id);
        if (row.claim_attempts >= MAX_CLAIMS || !safeEqual(hashToken(secret), row.secret_hash)) {
            throw new HttpError(403, "This connection request doesn't belong to this browser.", "forbidden");
        }
        if (row.status === "declined") {
            await db.prepare("DELETE FROM link_requests WHERE id = ?").run(row.id);
            throw new HttpError(410, "The connection was declined on the website.", "declined");
        }
        if (row.status !== "approved") {
            ctx.status = 202;
            return { status: "pending" };
        }
        const user = await db.prepare("SELECT email FROM users WHERE id = ?").get(row.user_id);
        const claimed = await db.prepare("DELETE FROM link_requests WHERE id = ? AND status = 'approved' AND secret_hash = ? AND expires_at > ? RETURNING *").get(row.id, hashToken(secret), Date.now());
        if (!claimed)
            throw new HttpError(410, "This connection request was already claimed or expired.", "expired");
        return { status: "approved", token: claimed.token, deviceId: claimed.device_id, wrappedKey: JSON.parse(claimed.wrapped_key), email: user?.email || "" };
    });
}
