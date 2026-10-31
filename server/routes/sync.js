// History sync for linked browsers.

import { transaction, nextSeq } from "../db.js";
import * as validate from "../validate.js";
import { userSettings } from "./common.js";
import { shouldNotify, notificationFor, notifyUser } from "../notify.js";

const COLUMNS = [
  "started_at", "finished_at", "state", "kind", "method", "mode", "live", "bytes", "received", "media_duration",
  "elapsed_ms", "active_ms", "avg_speed", "peak_speed", "height", "codecs", "container", "fps", "concurrency",
  "concurrency_auto", "error_code", "samples", "sealed"
];

export function registerSync(router, deps) {
  const { db, hub } = deps;

  const upsert = db.prepare(`
    INSERT INTO downloads (user_id, id, device_id, seq, ${COLUMNS.join(", ")})
    VALUES (:user_id, :id, :device_id, :seq, ${COLUMNS.map((column) => `:${column}`).join(", ")})
    ON CONFLICT(user_id, id) DO UPDATE SET
      device_id = excluded.device_id, seq = excluded.seq,
      ${COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}
    RETURNING notified`);

  router.post("/api/sync/push", { auth: "device" }, (ctx) => {
    const items = ctx.body.entries;
    if (!Array.isArray(items) || items.length > 100) throw validate.bad("Send up to 100 entries at a time.");
    const accepted = [];
    const rejected = [];
    const toNotify = [];
    transaction(db, () => {
      for (const item of items) {
        let entry;
        try {
          entry = validate.entry(item);
        } catch (error) {
          rejected.push({ id: typeof item?.id === "string" ? item.id.slice(0, 64) : null, error: error.message });
          continue;
        }
        // Deleted on the website: don't resurrect it from a stale outbox.
        if (db.prepare("SELECT 1 FROM tombstones WHERE user_id = ? AND id = ?").get(ctx.user.id, entry.id)) {
          accepted.push(entry.id);
          continue;
        }
        const { notify_title: notifyTitle, ...columns } = entry;
        const row = upsert.get({ ...columns, user_id: ctx.user.id, device_id: ctx.device.id, seq: nextSeq(db, ctx.user.id) });
        accepted.push(entry.id);
        if (!row.notified && shouldNotify(entry, ctx.user)) {
          db.prepare("UPDATE downloads SET notified = 1 WHERE user_id = ? AND id = ?").run(ctx.user.id, entry.id);
          toNotify.push({ ...entry, notify_title: notifyTitle });
        }
      }
    });
    if (accepted.length) hub.emit(ctx.user.id, "library", {});
    for (const entry of toNotify) {
      notifyUser(db, deps, ctx.user.id, { ...notificationFor(entry), tag: entry.id, url: `/library/${entry.id}` }).catch(() => {});
    }
    return { accepted, rejected };
  });

  router.get("/api/sync/pull", { auth: "device" }, (ctx) => {
    const since = validate.number(ctx.url.searchParams.get("since"), { integer: true }) || 0;
    const cursor = db.prepare("SELECT seq FROM users WHERE id = ?").get(ctx.user.id).seq;
    const deleted = db.prepare("SELECT id FROM tombstones WHERE user_id = ? AND seq > ?").all(ctx.user.id, since).map((row) => row.id);
    const inbox = db.prepare(`SELECT id, sealed, created_at FROM inbox
                              WHERE user_id = ? AND opened_at IS NULL AND (target_device_id IS NULL OR target_device_id = ?)
                              ORDER BY created_at`).all(ctx.user.id, ctx.device.id)
      .map((row) => ({ id: row.id, sealed: row.sealed, createdAt: row.created_at }));
    return { settings: userSettings(ctx.user), deleted, inbox, cursor, deviceName: ctx.device.name };
  });
}
