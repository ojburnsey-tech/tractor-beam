import * as validate from "../validate.js";
import { userSettings } from "./common.js";
import { shouldNotify, notificationFor, notifyUser } from "../notify.js";
const COLUMNS = ["started_at", "finished_at", "state", "kind", "method", "mode", "live", "bytes", "received", "media_duration", "elapsed_ms", "active_ms", "avg_speed", "peak_speed", "height", "codecs", "container", "fps", "concurrency", "concurrency_auto", "error_code", "samples", "sealed"];
export function registerSync(router, deps) {
    const { db, hub } = deps;
    router.post("/api/sync/push", { auth: "device" }, async (ctx) => {
        const items = ctx.body.entries;
        if (!Array.isArray(items) || items.length > 100)
            throw validate.bad("Send up to 100 entries at a time.");
        const accepted = [];
        const rejected = [];
        const entries = [];
        for (const item of items) {
            try {
                entries.push(validate.entry(item));
            }
            catch (error) {
                rejected.push({ id: typeof item?.id === "string" ? item.id.slice(0, 64) : null, error: error.message });
            }
        }
        for (let offset = 0; offset < entries.length; offset += 20) {
            const chunk = entries.slice(offset, offset + 20);
            const statements = [];
            for (const entry of chunk) {
                statements.push(db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").statement(ctx.user.id));
                statements.push(db.prepare(`INSERT INTO downloads (user_id, id, device_id, seq, ${COLUMNS.join(", ")})
          SELECT ?, ?, ?, (SELECT seq FROM users WHERE id = ?), ${COLUMNS.map(() => "?").join(", ")}
          WHERE NOT EXISTS (SELECT 1 FROM tombstones WHERE user_id = ? AND id = ?)
          ON CONFLICT(user_id, id) DO UPDATE SET device_id = excluded.device_id, seq = excluded.seq,
          ${COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`)
                    .statement(ctx.user.id, entry.id, ctx.device.id, ctx.user.id, ...COLUMNS.map((column) => entry[column] ?? null), ctx.user.id, entry.id));
                statements.push(db.prepare("UPDATE downloads SET notified = 1 WHERE user_id = ? AND id = ? AND notified = 0 AND ? = 1 RETURNING id")
                    .statement(ctx.user.id, entry.id, shouldNotify(entry, ctx.user) ? 1 : 0));
            }
            const result = await db.batch(statements);
            for (let index = 0; index < chunk.length; index += 1) {
                const entry = chunk[index];
                accepted.push(entry.id);
                if (result[index * 3 + 2].results.length) {
                    ctx.execution.waitUntil(notifyUser(db, deps, ctx.user.id, { ...notificationFor(entry), tag: entry.id, url: `/library/${entry.id}` }).catch(() => { }));
                }
            }
        }
        if (accepted.length)
            await hub.emit(ctx.user.id, "library", {});
        return { accepted, rejected };
    });
    router.get("/api/sync/pull", { auth: "device" }, async (ctx) => {
        const since = validate.number(ctx.url.searchParams.get("since"), { integer: true }) || 0;
        const result = await db.batch([
            db.prepare("SELECT * FROM users WHERE id = ?").statement(ctx.user.id),
            db.prepare("SELECT id FROM tombstones WHERE user_id = ? AND seq > ?").statement(ctx.user.id, since),
            db.prepare(`SELECT id, sealed, created_at FROM inbox WHERE user_id = ? AND opened_at IS NULL
        AND (target_device_id IS NULL OR target_device_id = ?) ORDER BY created_at`).statement(ctx.user.id, ctx.device.id)
        ]);
        const user = result[0].results[0];
        return {
            settings: userSettings(user), deleted: result[1].results.map((row) => row.id),
            inbox: result[2].results.map((row) => ({ id: row.id, sealed: row.sealed, createdAt: row.created_at })),
            cursor: user.seq, deviceName: ctx.device.name
        };
    });
}
