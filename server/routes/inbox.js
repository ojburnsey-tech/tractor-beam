// "Send to computer": links sent from the website to a linked browser.

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

  router.get("/api/inbox", (ctx) => {
    db.prepare("DELETE FROM inbox WHERE user_id = ? AND created_at < ?").run(ctx.user.id, Date.now() - KEEP_MS);
    return { items: db.prepare("SELECT * FROM inbox WHERE user_id = ? ORDER BY created_at DESC").all(ctx.user.id).map(json) };
  });

  router.post("/api/inbox", (ctx) => {
    const id = validate.string(ctx.body.id, { pattern: validate.ID, name: "Item id" });
    const sealed = validate.sealed(ctx.body.sealed, 8192);
    let target = null;
    if (ctx.body.targetDeviceId) {
      target = validate.string(ctx.body.targetDeviceId, { max: 64, name: "Browser" });
      if (!db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND id = ?").get(ctx.user.id, target)) {
        throw new HttpError(404, "That browser is no longer connected.");
      }
    }
    const waiting = db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE user_id = ? AND opened_at IS NULL").get(ctx.user.id).count;
    if (waiting >= 100) throw new HttpError(429, "100 links are already waiting. Open or remove some first.");
    db.prepare("INSERT INTO inbox (id, user_id, target_device_id, sealed, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, ctx.user.id, target, sealed, Date.now());
    hub.emit(ctx.user.id, "inbox", {});
    ctx.status = 201;
    return { item: json(db.prepare("SELECT * FROM inbox WHERE id = ?").get(id)) };
  });

  router.delete("/api/inbox/:id", (ctx) => {
    db.prepare("DELETE FROM inbox WHERE user_id = ? AND id = ?").run(ctx.user.id, ctx.params.id);
    hub.emit(ctx.user.id, "inbox", {});
    return { ok: true };
  });

  router.post("/api/inbox/:id/opened", { auth: "device" }, (ctx) => {
    const changed = db.prepare("UPDATE inbox SET opened_at = ?, opened_by = ? WHERE user_id = ? AND id = ? AND opened_at IS NULL")
      .run(Date.now(), ctx.device.id, ctx.user.id, ctx.params.id).changes;
    if (changed) hub.emit(ctx.user.id, "inbox", {});
    return { ok: true };
  });

  router.post("/api/inbox/:id/dismissed", { auth: "device" }, (ctx) => {
    db.prepare("DELETE FROM inbox WHERE user_id = ? AND id = ?").run(ctx.user.id, ctx.params.id);
    hub.emit(ctx.user.id, "inbox", {});
    return { ok: true };
  });
}
