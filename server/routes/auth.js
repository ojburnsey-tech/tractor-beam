// Sign-up, sign-in and sign-out.

import { HttpError } from "../http.js";
import { hashSecret, verifySecret, newId, DUMMY_HASH } from "../security.js";
import * as validate from "../validate.js";
import { publicUser } from "./common.js";

const KDF_ITERATIONS = 600000;

export function registerAuth(router, { db, config, limits, sessions }) {
  const signupOpen = () => config.allowSignup || db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0;

  router.get("/api/auth/state", { auth: "optional" }, (ctx) => ({
    signupOpen: signupOpen(),
    user: ctx.user ? publicUser(ctx.user) : null
  }));

  router.post("/api/auth/signup", { auth: "none" }, async (ctx, res) => {
    if (!signupOpen()) throw new HttpError(403, "Sign-up is closed on this server. Sign in with the existing account.", "signup-closed");
    limits.signup.hit(ctx.ip);
    const email = validate.email(ctx.body.email);
    const authHash = validate.authHash(ctx.body.authHash);
    const vault = validate.wrappedVault(ctx.body.vault);
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
      throw new HttpError(409, "An account with this email already exists.", "exists");
    }
    const id = newId();
    db.prepare(`INSERT INTO users (id, email, auth_hash, kdf_iterations, vault, settings, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, email, await hashSecret(authHash), KDF_ITERATIONS, vault, JSON.stringify(validate.DEFAULT_SETTINGS), Date.now());
    sessions.create(res, ctx, id);
    ctx.status = 201;
    return { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)) };
  });

  router.post("/api/auth/signin", { auth: "none" }, async (ctx, res) => {
    const email = validate.email(ctx.body.email);
    limits.signinIp.check(ctx.ip);
    limits.signinEmail.check(email);
    const authHash = validate.authHash(ctx.body.authHash);
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const valid = await verifySecret(authHash, user?.auth_hash || DUMMY_HASH);
    if (!user || !valid) {
      limits.signinIp.hit(ctx.ip);
      limits.signinEmail.hit(email);
      throw new HttpError(401, "Your email or password is incorrect.", "credentials");
    }
    limits.signinEmail.reset(email);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").run(user.id, Date.now());
    sessions.create(res, ctx, user.id);
    return { user: publicUser(user) };
  });

  router.post("/api/auth/signout", (ctx, res) => {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(ctx.session.id);
    sessions.clear(res, ctx);
    return { ok: true };
  });
}
