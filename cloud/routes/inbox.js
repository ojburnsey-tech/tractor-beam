import { HttpError } from "../http.js";
import * as validate from "../validate.js";
const KEEP_MS = 30 * 86400000;
export function registerInbox(router, { db, hub }) {
    const json = (row) => ({
        id: row.id,
        sealed: row.sealed,
        targetDeviceId: row.target_device_id,
        createdAt: row.created_at,
        openedAt: row.opened_at,
        openedBy: row.opened_by
    });
    router.get("/api/inbox", async (ctx) => {
        await db.prepare("DELETE FROM inbox WHERE user_id = ? AND created_at < ?").run(ctx.user.id, Date.now() - KEEP_MS);
        return { items: (await db.prepare("SELECT * FROM inbox WHERE user_id = ? ORDER BY created_at DESC").all(ctx.user.id)).map(json) };
    });
    router.post("/api/inbox", async (ctx) => {
        const id = validate.string(ctx.body.id, { pattern: validate.ID, name: "Item id" });
        const sealed = validate.sealed(ctx.body.sealed, 8192);
        let target = null;
        if (ctx.body.targetDeviceId) {
            target = validate.string(ctx.body.targetDeviceId, { max: 64, name: "Browser" });
            if (!await db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND id = ?").get(ctx.user.id, target)) {
                throw new HttpError(404, "That browser is no longer connected.");
            }
        }
        const waiting = (await db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE user_id = ? AND opened_at IS NULL").get(ctx.user.id)).count;
        if (waiting >= 100)
            throw new HttpError(429, "100 links are already waiting. Open or remove some first.");
        await db.prepare("INSERT INTO inbox (id, user_id, target_device_id, sealed, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(id, ctx.user.id, target, sealed, Date.now());
        await hub.emit(ctx.user.id, "inbox", {});
        ctx.status = 201;
        return { item: json(await db.prepare("SELECT * FROM inbox WHERE id = ?").get(id)) };
    });
    router.delete("/api/inbox/:id", async (ctx) => {
        await db.prepare("DELETE FROM inbox WHERE user_id = ? AND id = ?").run(ctx.user.id, ctx.params.id);
        await hub.emit(ctx.user.id, "inbox", {});
        return { ok: true };
    });
    router.post("/api/inbox/:id/opened", { auth: "device" }, async (ctx) => {
        const changed = (await db.prepare("UPDATE inbox SET opened_at = ?, opened_by = ? WHERE user_id = ? AND id = ? AND opened_at IS NULL AND (target_device_id IS NULL OR target_device_id = ?) RETURNING id")
            .run(Date.now(), ctx.device.id, ctx.user.id, ctx.params.id, ctx.device.id)).changes;
        if (changed)
            await hub.emit(ctx.user.id, "inbox", {});
        return { ok: true };
    });
    router.post("/api/inbox/:id/dismissed", { auth: "device" }, async (ctx) => {
        await db.prepare("DELETE FROM inbox WHERE user_id = ? AND id = ? AND (target_device_id IS NULL OR target_device_id = ?)").run(ctx.user.id, ctx.params.id, ctx.device.id);
        await hub.emit(ctx.user.id, "inbox", {});
        return { ok: true };
    });
}
