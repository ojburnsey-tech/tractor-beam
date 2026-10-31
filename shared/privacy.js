// Privacy rules applied before anything leaves the extension.

// Query parameter names that commonly carry credentials or signed tokens.
const SECRET_PARAM = /token|signature|auth|key|expire|expiry|policy|session|jwt|hash|hmac|credential|secret|password|nonce|^(sig|sess|access|pass|code|hdnts|hdnea|acl|exp|st|e)$|^x-(amz|goog)-/i;
// Tracking parameters carry no meaning for the person and identify them.
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|si|ref|ref_src|_hsenc|_hsmi|yclid)$/i;

/**
 * Returns a page URL that is safe to keep in history: http(s) only, no
 * credentials, no fragment, and no token-like or tracking query parameters.
 * Values longer than 64 characters are dropped as well, since long opaque
 * values are almost always signatures.
 */
export function cleanPageUrl(value) {
  let url;
  try { url = new URL(value); } catch { return ""; }
  if (!/^https?:$/.test(url.protocol)) return "";
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const [name, parameter] of [...url.searchParams.entries()]) {
    if (SECRET_PARAM.test(name) || TRACKING_PARAM.test(name) || parameter.length > 64) url.searchParams.delete(name);
  }
  url.search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : "";
  return url.href;
}

/** The site a page belongs to, without "www.": "https://www.bbc.co.uk/x" → "bbc.co.uk". */
export function siteOf(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Turns what someone typed into a site pattern: "https://www.Example.com/path"
 * → "example.com". Returns "" when it isn't a plausible host name.
 */
export function normalizeSitePattern(input) {
  let text = String(input || "").trim().toLowerCase();
  if (!text) return "";
  if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`;
  let host;
  try { host = new URL(text).hostname; } catch { return ""; }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$/.test(host)) return "";
  if (!host.includes(".") && host !== "localhost") return "";
  return host;
}

/** True when `host` is one of `patterns` or a subdomain of one. */
export function hostMatches(host, patterns = []) {
  const name = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!name) return false;
  return patterns.some((pattern) => name === pattern || name.endsWith(`.${pattern}`));
}
