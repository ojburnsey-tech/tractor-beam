// Web Push subscriptions for "download finished" alerts.

import { HttpError } from "../http.js";
import * as validate from "../validate.js";
import { isAllowedPushEndpoint } from "../webpush.js";
import { notifyUser } from "../notify.js";

export function registerPush(router, deps) {
  const { db, vapid } = deps;

  router.get("/api/push/key", () => ({ publicKey: vapid.publicKey }));

  router.post("/api/push/subscriptions", (ctx) => {
    const subscription = ctx.body.subscription || {};
    const endpoint = validate.string(subscription.endpoint, { max: 1000, name: "Endpoint" });
    if (!isAllowedPushEndpoint(endpoint)) throw validate.bad("That push service isn't supported.");
    const p256dh = validate.string(subscription.keys?.p256dh, { min: 87, max: 87, pattern: /^[A-Za-z0-9_-]+$/, name: "Key" });
    const auth = validate.string(subscription.keys?.auth, { min: 22, max: 22, pattern: /^[A-Za-z0-9_-]+$/, name: "Key" });
    const label = validate.string(String(ctx.body.label || "").slice(0, 80), { max: 80, name: "Label" });
    db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`)
      .run(endpoint, ctx.user.id, p256dh, auth, label, Date.now());
    ctx.status = 201;
    return { ok: true };
  });

  router.delete("/api/push/subscriptions", (ctx) => {
    const endpoint = validate.string(ctx.body.endpoint, { max: 1000, name: "Endpoint" });
    db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(ctx.user.id, endpoint);
    return { ok: true };
  });

  router.get("/api/push/subscriptions", (ctx) => ({
    subscriptions: db.prepare("SELECT endpoint, label, created_at FROM push_subscriptions WHERE user_id = ?").all(ctx.user.id)
      .map((row) => ({ endpoint: row.endpoint, label: row.label, createdAt: row.created_at }))
  }));

  router.post("/api/push/test", async (ctx) => {
    const result = await notifyUser(db, deps, ctx.user.id, {
      title: "Notifications are on",
      body: "You'll hear from MP4 Grabber when a download finishes.",
      tag: "test",
      url: "/settings"
    });
    if (!result.total) throw new HttpError(409, "Turn on notifications for this device first.");
    return result;
  });
}
