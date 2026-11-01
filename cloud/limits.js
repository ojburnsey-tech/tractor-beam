import { hashToken } from "./security.js";
import { HttpError } from "./http.js";
export function rateLimits(db) {
    function limiter(name, limit, windowMs) {
        const keyFor = (key) => `${name}:${hashToken(key)}`;
        function blocked(expiresAt) {
            const retryAfter = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
            throw new HttpError(429, "Too many attempts. Try again later.", "rate-limited", { retryAfter });
        }
        return {
            async check(key) {
                const row = await db.prepare("SELECT count, expires_at FROM rate_limits WHERE key = ?").get(keyFor(key));
                if (row?.expires_at > Date.now() && row.count >= limit)
                    blocked(row.expires_at);
            },
            async hit(key) {
                const now = Date.now();
                const row = await db.prepare(`INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 1, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
          window_start = CASE WHEN expires_at <= ? THEN excluded.window_start ELSE window_start END,
          expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
          RETURNING count, expires_at`).get(keyFor(key), now, now + windowMs, now, now, now);
                if (row.count > limit)
                    blocked(row.expires_at);
                await db.prepare("DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < ? LIMIT 100)").run(now - 86400000);
            },
            async reset(key) { await db.prepare("DELETE FROM rate_limits WHERE key = ?").run(keyFor(key)); }
        };
    }
    return {
        signinIp: limiter("signin-ip", 20, 900000),
        signinEmail: limiter("signin-email", 6, 900000),
        signup: limiter("signup", 5, 3600000),
        link: limiter("link", 20, 3600000),
        password: limiter("password", 6, 900000)
    };
}
