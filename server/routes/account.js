// The signed-in person's account: settings, password, deletion.

import { HttpError } from "../http.js";
import { hashSecret, verifySecret } from "../security.js";
import * as validate from "../validate.js";
import { publicUser, userSettings } from "./common.js";

export function registerAccount(router, { db, hub, limits, sessions }) {
  async function confirmPassword(ctx, value) {
    limits.password.check(ctx.user.id);
    const ok = await verifySecret(validate.authHash(value), ctx.user.auth_hash);
    if (!ok) {
      limits.password.hit(ctx.user.id);
      throw new HttpError(403, "That password is incorrect.", "credentials");
    }
  }

  router.get("/api/me", (ctx) => ({ user: publicUser(ctx.user) }));

  router.patch("/api/me/settings", (ctx) => {
    const settings = validate.settings(ctx.body.settings, userSettings(ctx.user));
    db.prepare("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(settings), ctx.user.id);
    hub.emit(ctx.user.id, "settings", { settings });
    return { settings };
  });

  router.post("/api/me/password", async (ctx) => {
    await confirmPassword(ctx, ctx.body.authHash);
    const newHash = validate.authHash(ctx.body.newAuthHash);
    const vault = validate.wrappedVault(ctx.body.vault);
    db.prepare("UPDATE users SET auth_hash = ?, vault = ? WHERE id = ?").run(await hashSecret(newHash), vault, ctx.user.id);
    // Sign out everywhere else; this session stays signed in.
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(ctx.user.id, ctx.session.id);
    return { ok: true };
  });

  router.post("/api/me/delete", async (ctx, res) => {
    await confirmPassword(ctx, ctx.body.authHash);
    db.prepare("DELETE FROM users WHERE id = ?").run(ctx.user.id);
    hub.emit(ctx.user.id, "signed-out", {});
    sessions.clear(res, ctx);
    return { ok: true };
  });
}
