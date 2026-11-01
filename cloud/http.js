export class HttpError extends Error {
    constructor(status, message, code = undefined, extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}
export function parseCookies(header = "") {
    const cookies = {};
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index < 0)
            continue;
        const name = part.slice(0, index).trim();
        if (name)
            cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}
export function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = "Lax", path: cookiePath = "/" } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, `SameSite=${sameSite}`];
    if (maxAge !== undefined)
        parts.push(`Max-Age=${Math.floor(maxAge)}`);
    if (httpOnly)
        parts.push("HttpOnly");
    if (secure)
        parts.push("Secure");
    return parts.join("; ");
}
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join("; ");
export function securityHeaders(res, { secure }) {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (secure)
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
}
export class Router {
    constructor() {
        this.routes = [];
    }
    add(method, pattern, options, handler) {
        if (typeof options === "function")
            [options, handler] = [{}, options];
        const keys = [];
        const regex = new RegExp(`^${pattern.replace(/\/:(\w+)/g, (_, key) => { keys.push(key); return "/([^/]+)"; })}$`);
        this.routes.push({ method, regex, keys, options, handler });
    }
    get(pattern, options, handler) { this.add("GET", pattern, options, handler); }
    post(pattern, options, handler) { this.add("POST", pattern, options, handler); }
    patch(pattern, options, handler) { this.add("PATCH", pattern, options, handler); }
    delete(pattern, options, handler) { this.add("DELETE", pattern, options, handler); }
    match(method, pathname) {
        let pathMatched = false;
        for (const route of this.routes) {
            const found = route.regex.exec(pathname);
            if (!found)
                continue;
            pathMatched = true;
            if (route.method !== method)
                continue;
            const params = {};
            route.keys.forEach((key, index) => { params[key] = decodeURIComponent(found[index + 1]); });
            return { route, params };
        }
        return pathMatched ? { methodNotAllowed: true } : null;
    }
}
