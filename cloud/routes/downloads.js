import { HttpError } from "../http.js";
import * as validate from "../validate.js";
import { entryJson } from "./common.js";
export function registerDownloads(router, { db, hub }) {
    router.get("/api/downloads", async (ctx) => {
        const since = validate.number(ctx.url.searchParams.get("since"), { integer: true }) || 0;
        const result = await db.batch([
            db.prepare("SELECT seq FROM users WHERE id = ?").statement(ctx.user.id),
            db.prepare("SELECT * FROM downloads WHERE user_id = ? AND seq > ? ORDER BY seq").statement(ctx.user.id, since),
            db.prepare("SELECT id FROM tombstones WHERE user_id = ? AND seq > ?").statement(ctx.user.id, since)
        ]);
        return { entries: result[1].results.map(entryJson), deleted: since ? result[2].results.map((row) => row.id) : [], cursor: result[0].results[0].seq };
    });
    async function remove(userId, ids) {
        for (let offset = 0; offset < ids.length; offset += 25) {
            const statements = [];
            for (const id of ids.slice(offset, offset + 25)) {
                statements.push(db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").statement(userId));
                statements.push(db.prepare("DELETE FROM downloads WHERE user_id = ? AND id = ?").statement(userId, id));
                statements.push(db.prepare(`INSERT INTO tombstones (user_id, id, seq, deleted_at)
          SELECT ?, ?, seq, ? FROM users WHERE id = ?
          ON CONFLICT(user_id, id) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at`).statement(userId, id, Date.now(), userId));
            }
            await db.batch(statements);
        }
        await hub.emit(userId, "library", {});
    }
    router.delete("/api/downloads/:id", async (ctx) => {
        const id = validate.string(ctx.params.id, { pattern: validate.ID, name: "Entry id" });
        if (!await db.prepare("SELECT 1 FROM downloads WHERE user_id = ? AND id = ?").get(ctx.user.id, id))
            throw new HttpError(404, "That download is already gone.");
        await remove(ctx.user.id, [id]);
        return { ok: true };
    });
    router.post("/api/downloads/delete-all", async (ctx) => {
        const rows = await db.prepare("SELECT id FROM downloads WHERE user_id = ?").all(ctx.user.id);
        await remove(ctx.user.id, rows.map((row) => row.id));
        return { deleted: rows.length };
    });
    router.post("/api/downloads/reseal", async (ctx) => {
        const items = ctx.body.entries;
        if (!Array.isArray(items) || items.length > 500)
            throw validate.bad("Send up to 500 entries at a time.");
        const entries = items.map((item) => ({ id: validate.string(item?.id, { pattern: validate.ID, name: "Entry id" }), sealed: validate.sealed(item.sealed) }));
        let updated = 0;
        for (let offset = 0; offset < entries.length; offset += 25) {
            const statements = [];
            for (const item of entries.slice(offset, offset + 25)) {
                statements.push(db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").statement(ctx.user.id));
                statements.push(db.prepare("UPDATE downloads SET sealed = ?, seq = (SELECT seq FROM users WHERE id = ?) WHERE user_id = ? AND id = ?").statement(item.sealed, ctx.user.id, ctx.user.id, item.id));
            }
            const result = await db.batch(statements);
            updated += result.reduce((sum, item, index) => sum + (index % 2 ? item.meta.changes : 0), 0);
        }
        await hub.emit(ctx.user.id, "library", {});
        return { updated };
    });
}
