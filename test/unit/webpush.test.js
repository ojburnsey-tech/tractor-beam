import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createHmac, createDecipheriv, generateKeyPairSync, verify, createPublicKey, randomBytes } from "node:crypto";
import { encryptPayload, vapidAuthorization, isAllowedPushEndpoint } from "../../server/webpush.js";

function hkdf(salt, ikm, info, length) {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** Decrypts as the browser (user agent) would, per RFC 8291. */
function decryptAsBrowser(body, receiver, auth) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const shared = receiver.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), senderPublic]);
  const ikm = hkdf(auth, shared, keyInfo, 32);
  const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(recordSize, 4096);
  assert.equal(padded.at(-1), 2, "single record ends with the 0x02 delimiter");
  return padded.subarray(0, -1).toString();
}

test("push payloads decrypt exactly as a browser would", () => {
  const browser = createECDH("prime256v1");
  browser.generateKeys();
  const auth = randomBytes(16);
  const message = JSON.stringify({ title: "Download finished", body: "1.4 GB in 3:12" });
  const body = encryptPayload(message, browser.getPublicKey().toString("base64url"), auth.toString("base64url"));
  assert.equal(decryptAsBrowser(body, browser, auth), message);
});

test("RFC 8291 appendix A test vector", () => {
  // Sender/receiver keys, salt and expected output from RFC 8291 §5/Appendix A.
  const receiverPrivate = Buffer.from("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", "base64url");
  const receiver = createECDH("prime256v1");
  receiver.setPrivateKey(receiverPrivate);
  const sender = createECDH("prime256v1");
  sender.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const body = encryptPayload("When I grow up, I want to be a watermelon", receiver.getPublicKey().toString("base64url"), "BTBZMqHH6r4Tts7J_aSIgg", {
    salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
    ecdh: sender
  });
  assert.equal(
    body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
  );
});

test("VAPID header carries a valid ES256 signature for the endpoint's origin", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/xyz", { privateKey, publicKey: raw }, "mailto:me@example.com");
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(key, raw);
  const [head, claims, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(payload.aud, "https://fcm.googleapis.com");
  assert.equal(payload.sub, "mailto:me@example.com");
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});

test("only browser push services are contacted", () => {
  assert.ok(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(isAllowedPushEndpoint("https://web.push.apple.com/QK"));
  assert.ok(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
  assert.ok(!isAllowedPushEndpoint("http://fcm.googleapis.com/x"));
  assert.ok(!isAllowedPushEndpoint("https://evil.com/googleapis.com"));
  assert.ok(!isAllowedPushEndpoint("https://googleapis.com.evil.com/"));
});
