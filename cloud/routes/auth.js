import { HttpError } from "../http.js";
import { hashSecret, verifySecret, newId, DUMMY_HASH } from "../security.js";
import * as validate from "../validate.js";
import { publicUser } from "./common.js";
const KDF_ITERATIONS = 600000;
export function registerAuth(router, { db, config, limits, sessions }) {
    const signupOpen = async () => config.allowSignup || (await db.prepare("SELECT COUNT(*) AS count FROM users").get()).count === 0;
    router.get("/api/auth/state", { auth: "optional" }, async (ctx) => {
        const open = await signupOpen();
        const authorized = Boolean(ctx.request.headers.get("oai-authenticated-user-id")) && ctx.request.headers.get("oai-authenticated-user-email")?.toLowerCase() === config.ownerEmail;
        return { signupOpen: open, setupRequired: open && !authorized, setupEmail: open && authorized ? config.ownerEmail : null, user: ctx.user ? publicUser(ctx.user) : null };
    });
    router.post("/api/auth/signup", { auth: "none" }, async (ctx, res) => {
        if (!await signupOpen())
            throw new HttpError(403, "Sign-up is closed on this server. Sign in with the existing account.", "signup-closed");
        await limits.signup.hit(ctx.ip);
        const email = validate.email(ctx.body.email);
        if (!config.ownerEmail || !ctx.request.headers.get("oai-authenticated-user-id") || ctx.request.headers.get("oai-authenticated-user-email")?.toLowerCase() !== config.ownerEmail || email !== config.ownerEmail) {
            throw new HttpError(403, "Sign in with the Site owner's ChatGPT account and use that account's email to set up this Library.", "owner-required");
        }
        const authHash = validate.authHash(ctx.body.authHash);
        const vault = validate.wrappedVault(ctx.body.vault);
        if (await db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
            throw new HttpError(409, "An account with this email already exists.", "exists");
        }
        const id = newId();
        await db.prepare(`INSERT INTO users (id, email, auth_hash, kdf_iterations, vault, settings, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(id, email, await hashSecret(authHash), KDF_ITERATIONS, vault, JSON.stringify(validate.DEFAULT_SETTINGS), Date.now());
        await sessions.create(res, ctx, id);
        ctx.status = 201;
        return { user: publicUser(await db.prepare("SELECT * FROM users WHERE id = ?").get(id)) };
    });
    router.post("/api/auth/signin", { auth: "none" }, async (ctx, res) => {
        const email = validate.email(ctx.body.email);
        await limits.signinIp.check(ctx.ip);
        await limits.signinEmail.check(email);
        const authHash = validate.authHash(ctx.body.authHash);
        const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
        const valid = await verifySecret(authHash, user?.auth_hash || DUMMY_HASH);
        if (!user || !valid) {
            await limits.signinIp.hit(ctx.ip);
            await limits.signinEmail.hit(email);
            throw new HttpError(401, "Your email or password is incorrect.", "credentials");
        }
        await limits.signinEmail.reset(email);
        await db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").run(user.id, Date.now());
        await sessions.create(res, ctx, user.id);
        return { user: publicUser(user) };
    });
    router.post("/api/auth/signout", async (ctx, res) => {
        await db.prepare("DELETE FROM sessions WHERE id = ?").run(ctx.session.id);
        sessions.clear(res, ctx);
        return { ok: true };
    });
}
