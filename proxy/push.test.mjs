import { describe, it, expect } from "vitest";
import {
  b64urlToBytes,
  bytesToB64url,
  generateVapidKeys,
  importVapidKeys,
  audienceOf,
  vapidHeader,
  encryptPayload,
  sendPush,
} from "./push.mjs";

const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/* -------------------------------------------------------------------------
   A subscriber, and the receiving half of RFC 8291.

   This is written from the specification rather than from push.mjs: it is the
   check that the sender derives the key the phone will actually derive. A
   wrong info string or the two public keys in the wrong order still produces
   perfectly valid-looking ciphertext — and a notification that never arrives.
   ------------------------------------------------------------------------- */

async function makeSubscriber(endpoint = "https://push.example.test/send/abc123") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint, p256dh: bytesToB64url(p256dh), auth: bytesToB64url(auth) },
    privateKey: pair.privateKey,
    publicKey: p256dh,
    authSecret: auth,
  };
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

async function decrypt(body, subscriber) {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const recordSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16, false);
  const idLen = bytes[20];
  const asPublic = bytes.slice(21, 21 + idLen);
  const ciphertext = bytes.slice(21 + idLen);

  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, subscriber.privateKey, 256),
  );

  const keyInfo = concat(
    utf8("WebPush: info"),
    new Uint8Array([0]),
    subscriber.publicKey,
    asPublic,
  );
  const ikm = await hkdf(subscriber.authSecret, shared, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertext),
  );

  // strip the padding delimiter the sender appended
  const end = plain.lastIndexOf(2);
  return { text: new TextDecoder().decode(plain.slice(0, end)), recordSize, idLen };
}

describe("base64url", () => {
  it("round-trips bytes, including lengths that need padding", () => {
    for (const n of [1, 2, 3, 16, 31, 32, 65]) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(Array.from(b64urlToBytes(bytesToB64url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("produces url-safe output with no padding", () => {
    const encoded = bytesToB64url(new Uint8Array([251, 255, 190, 255]));
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("message encryption", () => {
  it("produces something the subscriber can actually decrypt", async () => {
    const sub = await makeSubscriber();
    const body = await encryptPayload("Due now: Water the plants", {
      userPublicKey: sub.subscription.p256dh,
      authSecret: sub.subscription.auth,
    });
    const { text } = await decrypt(body, sub);
    expect(text).toBe("Due now: Water the plants");
  });

  it("writes the aes128gcm header the format requires", async () => {
    const sub = await makeSubscriber();
    const body = await encryptPayload("hi", {
      userPublicKey: sub.subscription.p256dh,
      authSecret: sub.subscription.auth,
    });
    const { recordSize, idLen } = await decrypt(body, sub);
    expect(idLen).toBe(65); // an uncompressed P-256 point
    expect(recordSize).toBe(4096);
    // 16 salt + 4 record size + 1 length + 65 key + ciphertext + 16 tag
    expect(body.length).toBe(86 + 2 + 1 + 16);
  });

  it("uses a fresh key and salt for every message", async () => {
    const sub = await makeSubscriber();
    const opts = { userPublicKey: sub.subscription.p256dh, authSecret: sub.subscription.auth };
    const a = await encryptPayload("same text", opts);
    const b = await encryptPayload("same text", opts);
    expect(bytesToB64url(a)).not.toBe(bytesToB64url(b));
    // both still decrypt
    expect((await decrypt(a, sub)).text).toBe("same text");
    expect((await decrypt(b, sub)).text).toBe("same text");
  });

  it("survives a payload with emoji and newlines", async () => {
    const sub = await makeSubscriber();
    const text = "⏰ Due now: café\nmeeting; 2 of 3";
    const body = await encryptPayload(text, {
      userPublicKey: sub.subscription.p256dh,
      authSecret: sub.subscription.auth,
    });
    expect((await decrypt(body, sub)).text).toBe(text);
  });

  it("refuses a malformed subscription rather than sending gibberish", async () => {
    const sub = await makeSubscriber();
    await expect(
      encryptPayload("x", { userPublicKey: sub.subscription.p256dh, authSecret: bytesToB64url(new Uint8Array(8)) }),
    ).rejects.toThrow(/16-byte auth/);
    await expect(
      encryptPayload("x", { userPublicKey: bytesToB64url(new Uint8Array(32)), authSecret: sub.subscription.auth }),
    ).rejects.toThrow(/65 bytes/);
  });
});

describe("VAPID", () => {
  it("signs a JWT the push service can verify with the advertised key", async () => {
    const generated = await generateVapidKeys();
    const keys = await importVapidKeys(generated);
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);

    const header = await vapidHeader("https://push.example.test/send/abc123", keys, {
      subject: "mailto:steve.smith@buddyrents.com",
      now,
    });

    const m = header.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/);
    expect(m).not.toBeNull();
    const [, jwt, advertisedKey] = m;
    expect(advertisedKey).toBe(generated.publicKey);

    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlToBytes(h)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    // the audience is the origin, not the whole endpoint — the usual cause of a 401
    expect(claims.aud).toBe("https://push.example.test");
    expect(claims.sub).toBe("mailto:steve.smith@buddyrents.com");
    expect(claims.exp).toBe(Math.floor(now / 1000) + 12 * 3600);
    expect(claims.exp - Math.floor(now / 1000)).toBeLessThanOrEqual(24 * 3600);

    // verify exactly as the push service would: with the key from the header
    const verifyKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: bytesToB64url(b64urlToBytes(advertisedKey).slice(1, 33)),
        y: bytesToB64url(b64urlToBytes(advertisedKey).slice(33, 65)),
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      b64urlToBytes(s),
      utf8(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("takes the audience from the endpoint's origin", () => {
    expect(audienceOf("https://fcm.googleapis.com/fcm/send/abc:123")).toBe(
      "https://fcm.googleapis.com",
    );
    expect(audienceOf("https://web.push.apple.com/Qx/y/z?a=1")).toBe("https://web.push.apple.com");
  });

  it("rejects a private key that is not a P-256 scalar", async () => {
    const good = await generateVapidKeys();
    await expect(
      importVapidKeys({ publicKey: good.publicKey, privateKey: bytesToB64url(new Uint8Array(16)) }),
    ).rejects.toThrow(/32-byte/);
  });
});

describe("sendPush", () => {
  const subject = "mailto:steve.smith@buddyrents.com";

  it("posts to the endpoint with the headers the protocol requires", async () => {
    const sub = await makeSubscriber();
    const keys = await importVapidKeys(await generateVapidKeys());
    let seen = null;

    const res = await sendPush(sub.subscription, "Due now: Call the bank", keys, {
      subject,
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 201, text: async () => "" };
      },
    });

    expect(res).toMatchObject({ ok: true, status: 201, gone: false });
    expect(seen.url).toBe(sub.subscription.endpoint);
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(seen.init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(seen.init.headers.TTL).toBe("3600");
    expect(seen.init.headers.Urgency).toBe("high");
    expect(seen.init.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);

    // and the body really is the message
    expect((await decrypt(seen.init.body, sub)).text).toBe("Due now: Call the bank");
  });

  it("reports a dead subscription so the row can be dropped", async () => {
    const sub = await makeSubscriber();
    const keys = await importVapidKeys(await generateVapidKeys());

    for (const status of [404, 410]) {
      const res = await sendPush(sub.subscription, "x", keys, {
        subject,
        fetchImpl: async () => ({ ok: false, status, text: async () => "" }),
      });
      expect(res).toMatchObject({ ok: false, gone: true });
    }
  });

  it("keeps a subscription that failed for some other reason", async () => {
    const sub = await makeSubscriber();
    const keys = await importVapidKeys(await generateVapidKeys());
    const res = await sendPush(sub.subscription, "x", keys, {
      subject,
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => "slow down" }),
    });
    expect(res).toMatchObject({ ok: false, gone: false, status: 429 });
    expect(res.error).toContain("slow down");
  });

  it("turns a thrown network error into a result rather than an exception", async () => {
    const sub = await makeSubscriber();
    const keys = await importVapidKeys(await generateVapidKeys());
    const res = await sendPush(sub.subscription, "x", keys, {
      subject,
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });
    expect(res).toMatchObject({ ok: false, gone: false, status: 0 });
    expect(res.error).toContain("network down");
  });
});
