// The Library as the website sees it.

import { HttpError } from "../http.js";
import { transaction, nextSeq } from "../db.js";
import * as validate from "../validate.js";
import { entryJson } from "./common.js";

export function registerDownloads(router, { db, hub }) {
  router.get("/api/downloads", (ctx) => {
    const since = validate.number(ctx.url.searchParams.get("since"), { integer: true }) || 0;
    const cursor = db.prepare("SELECT seq FROM users WHERE id = ?").get(ctx.user.id).seq;
    const entries = db.prepare("SELECT * FROM downloads WHERE user_id = ? AND seq > ? ORDER BY seq").all(ctx.user.id, since).map(entryJson);
    const deleted = since
      ? db.prepare("SELECT id FROM tombstones WHERE user_id = ? AND seq > ?").all(ctx.user.id, since).map((row) => row.id)
      : [];
    return { entries, deleted, cursor };
  });

  function remove(userId, ids) {
    const now = Date.now();
    transaction(db, () => {
      for (const id of ids) {
        const seq = nextSeq(db, userId);
        db.prepare("DELETE FROM downloads WHERE user_id = ? AND id = ?").run(userId, id);
        db.prepare(`INSERT INTO tombstones (user_id, id, seq, deleted_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(user_id, id) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at`).run(userId, id, seq, now);
      }
    });
    hub.emit(userId, "library", {});
  }

  router.delete("/api/downloads/:id", (ctx) => {
    const id = validate.string(ctx.params.id, { pattern: validate.ID, name: "Entry id" });
    if (!db.prepare("SELECT 1 FROM downloads WHERE user_id = ? AND id = ?").get(ctx.user.id, id)) throw new HttpError(404, "That download is already gone.");
    remove(ctx.user.id, [id]);
    return { ok: true };
  });

  router.post("/api/downloads/delete-all", (ctx) => {
    const ids = db.prepare("SELECT id FROM downloads WHERE user_id = ?").all(ctx.user.id).map((row) => row.id);
    remove(ctx.user.id, ids);
    return { deleted: ids.length };
  });

  // Used when encryption is switched on or off: the browser re-seals every
  // entry and uploads the new blobs.
  router.post("/api/downloads/reseal", (ctx) => {
    const items = ctx.body.entries;
    if (!Array.isArray(items) || items.length > 500) throw validate.bad("Send up to 500 entries at a time.");
    let updated = 0;
    transaction(db, () => {
      for (const item of items) {
        const id = validate.string(item?.id, { pattern: validate.ID, name: "Entry id" });
        const sealed = validate.sealed(item.sealed);
        const seq = nextSeq(db, ctx.user.id);
        updated += db.prepare("UPDATE downloads SET sealed = ?, seq = ? WHERE user_id = ? AND id = ?").run(sealed, seq, ctx.user.id, id).changes;
      }
    });
    hub.emit(ctx.user.id, "library", {});
    return { updated };
  });
}
