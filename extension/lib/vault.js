// Client-side cryptography shared by the website and the extension.
//
// The server never sees the password or the data key. See docs/ARCHITECTURE.md
// ("Accounts and keys", "Sealed records", "Linking a browser") for the scheme.
// Runs unchanged in browsers, extension service workers and Node ≥ 22 because
// it only uses Web Crypto (globalThis.crypto.subtle).

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const KDF_ITERATIONS = 600000;
const VERSION = 1;
const LABEL = "mp4grabber/v1/";

export class VaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

// ---------- encoding ----------

export function toBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, view.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new VaultError("Malformed key material.", "malformed");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  // getRandomValues fills at most 65 536 bytes per call.
  for (let offset = 0; offset < length; offset += 65536) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65536)));
  }
  return bytes;
}

export function randomId(bytes = 16) {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// ---------- account keys ----------

/**
 * Derives the two secrets a password unlocks. `authHash` proves the password to
 * the server; `kek` (key-encryption key) unwraps the data key and never leaves
 * the client.
 */
export async function deriveAccountKeys(email, password, iterations = KDF_ITERATIONS) {
  if (!password) throw new VaultError("Enter your password.", "empty");
  const base = await subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const master = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(LABEL + normalizeEmail(email)), iterations },
    base,
    256
  );
  const hkdf = await subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
  const authBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(LABEL + "auth") },
    hkdf,
    256
  );
  const kek = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(LABEL + "vault") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return { authHash: toBase64Url(authBits), kek };
}

export async function createDataKey() {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportDataKey(key) {
  return toBase64Url(await subtle.exportKey("raw", key));
}

export async function importDataKey(raw) {
  const bytes = typeof raw === "string" ? fromBase64Url(raw) : raw;
  if (bytes.length !== 32) throw new VaultError("The encryption key is the wrong length.", "malformed");
  return subtle.importKey("raw", bytes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

export async function wrapDataKey(dataKey, kek) {
  const iv = randomBytes(12);
  const raw = await subtle.exportKey("raw", dataKey);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(LABEL + "vault") }, kek, raw);
  return { v: VERSION, iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

export async function unwrapDataKey(wrapped, kek) {
  try {
    const raw = await subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(wrapped.iv), additionalData: encoder.encode(LABEL + "vault") },
      kek,
      fromBase64Url(wrapped.ct)
    );
    return importDataKey(new Uint8Array(raw));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("That password doesn't unlock this library.", "wrong-password");
  }
}

// ---------- sealed records ----------

/**
 * Seals private fields for storage on the server. `aad` binds the ciphertext to
 * its record id so blobs can't be swapped between records.
 */
export async function seal(data, { key, encrypt, aad }) {
  if (!encrypt) return JSON.stringify({ v: VERSION, e: 0, d: data });
  if (!key) throw new VaultError("This browser doesn't have the encryption key yet.", "locked");
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(String(aad || "")) },
    key,
    encoder.encode(JSON.stringify(data))
  );
  return JSON.stringify({ v: VERSION, e: 1, iv: toBase64Url(iv), ct: toBase64Url(ct) });
}

export function isEncrypted(sealed) {
  try { return JSON.parse(sealed).e === 1; } catch { return false; }
}

export async function open(sealed, { key, aad }) {
  let envelope;
  try { envelope = JSON.parse(sealed); } catch { throw new VaultError("A record is damaged.", "malformed"); }
  if (envelope?.v !== VERSION) throw new VaultError("A record uses an unknown format.", "malformed");
  if (envelope.e === 0) return envelope.d && typeof envelope.d === "object" ? envelope.d : {};
  if (!key) throw new VaultError("Unlock your library to read this record.", "locked");
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(envelope.iv), additionalData: encoder.encode(String(aad || "")) },
      key,
      fromBase64Url(envelope.ct)
    );
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new VaultError("A record could not be decrypted with this key.", "undecryptable");
  }
}

// ---------- pairing (website → extension key hand-off) ----------

export async function createPairingKeys() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = toBase64Url(await subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey };
}

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Short code shown on both screens so the person can confirm they match. */
export async function pairingCode(publicKey) {
  const digest = await sha256(LABEL + "code:" + publicKey);
  let code = "";
  for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[digest[index] % CODE_ALPHABET.length];
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

async function pairingKey(privateKey, publicKeyBytes, salt) {
  const peer = await subtle.importKey("raw", publicKeyBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(LABEL + "pairing") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Website side: encrypts the data key so only the requesting extension can read it. */
export async function sealKeyForDevice(dataKey, devicePublicKey) {
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));
  const deviceBytes = fromBase64Url(devicePublicKey);
  const salt = randomBytes(16);
  const key = await pairingKey(ephemeral.privateKey, deviceBytes, salt);
  const iv = randomBytes(12);
  const raw = await subtle.exportKey("raw", dataKey);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: deviceBytes }, key, raw);
  return { v: VERSION, epk: toBase64Url(epk), salt: toBase64Url(salt), iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

/** Extension side: recovers the data key from the website's hand-off. */
export async function openKeyFromWeb(payload, privateKey, ownPublicKey) {
  try {
    const key = await pairingKey(privateKey, fromBase64Url(payload.epk), fromBase64Url(payload.salt));
    const raw = await subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(payload.iv), additionalData: fromBase64Url(ownPublicKey) },
      key,
      fromBase64Url(payload.ct)
    );
    return importDataKey(new Uint8Array(raw));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("The key from the website could not be opened. Start connecting again.", "pairing");
  }
}
