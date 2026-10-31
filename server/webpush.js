// Web Push without dependencies:
//   RFC 8291 — message encryption (aes128gcm content coding)
//   RFC 8292 — VAPID authentication (ES256 JWT)

import { createECDH, createCipheriv, createHmac, generateKeyPairSync, createPrivateKey, sign, randomBytes } from "node:crypto";
import { getMeta, setMeta } from "./db.js";

const RECORD_SIZE = 4096;

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF-Expand for a single block (all outputs here are ≤ 32 bytes). */
function hkdf(salt, ikm, info, length) {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/**
 * Encrypts `payload` for a browser's push subscription. Returns the request
 * body: header (salt, record size, sender public key) followed by one record.
 */
export function encryptPayload(payload, p256dh, authSecret, { salt = randomBytes(16), ecdh = null } = {}) {
  const receiverPublic = Buffer.from(p256dh, "base64url");
  const auth = Buffer.from(authSecret, "base64url");
  if (receiverPublic.length !== 65 || auth.length !== 16) throw new Error("Invalid push subscription keys.");

  const sender = ecdh || createECDH("prime256v1");
  if (!ecdh) sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(receiverPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
  const ikm = hkdf(auth, sharedSecret, keyInfo, 32);
  const contentKey = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record
  if (plaintext.length + 16 > RECORD_SIZE) throw new Error("Push payload too large.");
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, ciphertext]);
}

/** Loads the server's VAPID key pair, creating it on first run. */
export function loadVapid(db) {
  let stored = getMeta(db, "vapid");
  if (!stored) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    stored = JSON.stringify(privateKey.export({ format: "jwk" }));
    setMeta(db, "vapid", stored);
  }
  const jwk = JSON.parse(stored);
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return { privateKey, publicKey };
}

export function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const audience = new URL(endpoint).origin;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: vapid.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${unsigned}.${signature}, k=${vapid.publicKey}`;
}

/**
 * Sends one notification. Resolves to { ok, gone } where `gone` means the
 * subscription no longer exists and should be deleted.
 */
export async function sendPush(subscription, message, { vapid, subject, ttl = 24 * 3600, urgency = "normal" }) {
  const body = encryptPayload(JSON.stringify(message), subscription.p256dh, subscription.auth);
  try {
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        Urgency: urgency
      },
      body,
      signal: AbortSignal.timeout(10000)
    });
    await response.arrayBuffer().catch(() => {});
    return { ok: response.ok, gone: response.status === 404 || response.status === 410, status: response.status };
  } catch (error) {
    return { ok: false, gone: false, status: 0, error: error.message };
  }
}

/** Only push services run by browser vendors are contacted (no SSRF via fake endpoints). */
export function isAllowedPushEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:") return false;
  return /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)$/i.test(url.hostname);
}
