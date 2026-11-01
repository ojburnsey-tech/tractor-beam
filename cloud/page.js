import { securityHeaders } from "./http.js";
import html from "./page-html.js";
export function pageResponse(request) {
    const url = new URL(request.url);
    if (/\.[a-z0-9]+$/i.test(url.pathname))
        return new Response("Not found", { status: 404 });
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    securityHeaders({ setHeader: (key, value) => headers.set(key, value) }, { secure: url.protocol === "https:" });
    return new Response(html, { headers });
}
