// Password hashing, tokens and rate limiting.

import { scrypt, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(secret, salt) {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * The client already sends a 256-bit PBKDF2-derived value, never the password;
 * scrypt on top means a stolen database still can't be replayed to sign in.
 */
export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifySecret(secret, stored) {
  const [scheme, salt, expected] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) {
    // Equalise timing for unknown accounts.
    await scryptAsync(String(secret), randomBytes(16));
    return false;
  }
  const key = await scryptAsync(String(secret), Buffer.from(salt, "base64url"));
  const target = Buffer.from(expected, "base64url");
  return key.length === target.length && timingSafeEqual(key, target);
}

/** A dummy hash so sign-in takes the same time whether or not the email exists. */
export const DUMMY_HASH = "none";

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function newId() {
  return randomBytes(12).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("base64url");
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Fixed-window limiter with escalating lock-outs for repeated failures.
 * `hit(key)` throws 429 when the key is over its limit.
 */
export class RateLimiter {
  constructor({ limit, windowMs, lockMs = windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.entries = new Map();
  }

  check(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (entry?.lockedUntil > now) {
      const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
      throw new HttpError(429, `Too many attempts. Try again in ${retryAfter < 60 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`}.`, "rate-limited", { retryAfter });
    }
  }

  hit(key, now = Date.now()) {
    this.check(key, now);
    let entry = this.entries.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      entry = { windowStart: now, count: 0, lockedUntil: 0, strikes: entry?.strikes || 0 };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    if (entry.count >= this.limit) {
      entry.strikes += 1;
      entry.lockedUntil = now + Math.min(this.lockMs * 2 ** (entry.strikes - 1), 60 * 60 * 1000);
      entry.count = 0;
      entry.windowStart = now;
    }
    if (this.entries.size > 10000) this.sweep(now);
  }

  reset(key) {
    this.entries.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil < now && now - entry.windowStart > this.windowMs) this.entries.delete(key);
    }
  }
}
