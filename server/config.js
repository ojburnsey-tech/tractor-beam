// Runtime configuration from environment variables. Every value has a safe
// default so `npm start` works with no setup.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function flag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export function loadConfig(overrides = {}) {
  return {
    port: Number(process.env.PORT || 4321),
    // Loopback by default: the server is only reachable from this computer
    // until you deliberately expose it (Docker sets HOST=0.0.0.0).
    host: process.env.HOST || "127.0.0.1",
    dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, "data")),
    // Sign-up is open only while no account exists, unless forced on.
    allowSignup: flag("ALLOW_SIGNUP"),
    // Set when running behind a reverse proxy that terminates HTTPS.
    trustProxy: flag("TRUST_PROXY"),
    // Contact for push services (required by the Web Push protocol).
    vapidSubject: process.env.VAPID_SUBJECT || "mailto:owner@localhost",
    sessionDays: Number(process.env.SESSION_DAYS || 30),
    quiet: flag("QUIET"),
    ...overrides
  };
}
