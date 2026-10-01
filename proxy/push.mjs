// Web Push: the part that actually makes a phone buzz with the app closed.
//
// Two separate pieces of cryptography are involved, and it is easy to confuse
// them because both use P-256:
//
//   VAPID (RFC 8292) proves to the push service who is sending. One long-lived
//   signing keypair, used to sign a short JWT naming the push service as its
//   audience. This is identification, not secrecy.
//
//   Message encryption (RFC 8291) hides the payload from the push service,
//   which is only a relay. A FRESH keypair per message is agreed with the
//   subscription's own public key, mixed with the subscription's auth secret,
//   and the result encrypts one aes128gcm record (RFC 8188).
//
// Everything here is WebCrypto, so it runs unchanged in a Cloudflare Worker,
// in Node, and in a test.

/* ---------- base64url ---------- */

export function b64urlToBytes(value) {
  const s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

/* ---------- keys ---------- */

// An uncompressed P-256 point (0x04 || X || Y) as a JWK, which is the only
// public-key format WebCrypto will import for ECDH and ECDSA.
function pointToJwk(point, extra = {}) {
  const p = new Uint8Array(point);
  if (p.length !== 65 || p[0] !== 4) {
    throw new Error("expected an uncompressed P-256 public key of 65 bytes");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(p.slice(1, 33)),
    y: bytesToB64url(p.slice(33, 65)),
    ext: true,
    ...extra,
  };
}

async function importPublicKey(point, usage) {
  return crypto.subtle.importKey("jwk", pointToJwk(point), { name: usage, namedCurve: "P-256" }, true, []);
}

// The VAPID private key travels as the raw 32-byte scalar, so the public key
// has to come with it to rebuild a usable JWK.
export async function importVapidKeys({ publicKey, privateKey }) {
  const pub = b64urlToBytes(publicKey);
  const d = b64urlToBytes(privateKey);
  if (d.length !== 32) throw new Error("expected a 32-byte VAPID private key");

  const signing = await crypto.subtle.importKey(
    "jwk",
    pointToJwk(pub, { d: bytesToB64url(d), key_ops: ["sign"] }),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { signing, publicKey: pub };
}

// A fresh VAPID keypair. Printed by vapid-keygen.mjs; never generated per
// request, since the push service remembers which key a subscription was
// created with and rejects a different one.
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: bytesToB64url(pub), privateKey: jwk.d };
}

/* ---------- VAPID (RFC 8292) ---------- */

// The push service is the audience, and it is the ORIGIN of the endpoint, not
// the whole URL — sending the full path is the usual reason for a 401.
export function audienceOf(endpoint) {
  return new URL(endpoint).origin;
}

export async function vapidHeader(endpoint, keys, { subject, now = Date.now(), ttlSeconds = 12 * 3600 } = {}) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audienceOf(endpoint),
    // RFC 8292 caps this at 24 hours; 12 keeps clock skew from mattering.
    exp: Math.floor(now / 1000) + ttlSeconds,
    sub: subject,
  };

  const signingInput = `${bytesToB64url(utf8(JSON.stringify(header)))}.${bytesToB64url(
    utf8(JSON.stringify(payload)),
  )}`;

  // ECDSA here is the raw r||s pair, not the DER wrapping OpenSSL would give.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.signing, utf8(signingInput)),
  );

  const jwt = `${signingInput}.${bytesToB64url(signature)}`;
  return `vapid t=${jwt}, k=${bytesToB64url(keys.publicKey)}`;
}

/* ---------- payload encryption (RFC 8291 over RFC 8188) ---------- */

const RECORD_SIZE = 4096;

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// Returns the complete request body: the aes128gcm header followed by one
// encrypted record. `salt` and `localKeys` are injectable so a test can pin
// them; in use they are fresh every message.
export async function encryptPayload(
  plaintext,
  { userPublicKey, authSecret, salt = crypto.getRandomValues(new Uint8Array(16)), localKeys = null } = {},
) {
  const uaPublic = b64urlToBytes(userPublicKey);
  const auth = b64urlToBytes(authSecret);
  if (auth.length !== 16) throw new Error("expected a 16-byte auth secret");

  const pair =
    localKeys ||
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

  const uaKey = await importPublicKey(uaPublic, "ECDH");
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, pair.privateKey, 256),
  );

  // RFC 8291 §3.3. The two public keys go into the info in receiver-then-sender
  // order; swapping them produces a key the phone cannot derive, and the only
  // symptom is a notification that never arrives.
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(auth, shared, keyInfo, 32);

  const cek = await hkdf(salt, ikm, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // 0x02 is the padding delimiter that marks this as the final record.
  const record = concat(utf8(plaintext), new Uint8Array([2]));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record),
  );

  // RFC 8188 header: salt | record size | key id length | key id
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);

  return concat(header, sealed);
}

/* ---------- sending ---------- */

// Post one message. Returns { ok, status, gone, error }.
//
// `gone` is the one that matters operationally: 404 or 410 means the
// subscription is dead — the app was deleted, or notifications were turned off
// — and the row should be dropped rather than retried forever.
export async function sendPush(subscription, payload, keys, { subject, ttl = 3600, now = Date.now(), fetchImpl = globalThis.fetch, authorization: reuse = "" } = {}) {
  const { endpoint, p256dh, auth } = subscription;

  try {
    const body = await encryptPayload(payload, { userPublicKey: p256dh, authSecret: auth });
    // The JWT is per push service, not per message, and signing it costs real
    // CPU — which a Worker is rationed on. The caller may hand one back.
    const authorization = reuse || (await vapidHeader(endpoint, keys, { subject, now }));

    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        // Tell the phone to wake the screen rather than batch this with the
        // morning's news; a task that is due now is the whole point.
        Urgency: "high",
      },
      body,
    });

    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, gone: true, error: "subscription no longer exists" };
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* the body is optional and not worth failing over */
      }
      return { ok: false, status: res.status, gone: false, error: detail || `push service returned ${res.status}` };
    }

    return { ok: true, status: res.status, gone: false, error: "" };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err?.message || String(err) };
  }
}
