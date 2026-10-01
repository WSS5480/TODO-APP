// What the proxy is allowed to fetch.
//
// A service that fetches any URL a caller names is an open proxy, and an open
// proxy inside a hosting provider's network is worth something to somebody: it
// can be pointed at the provider's own metadata service, at anything else
// running in the same private network, or simply used to launder traffic. None
// of that is hypothetical, and none of it is needed here — the job is to read a
// published calendar.
//
// So the rules are narrow on purpose: https only, a known calendar host, and a
// public address. Everything else is refused before a socket is opened.
//
// Nothing here imports a runtime: the same rules apply whether this runs on
// Node or in a Cloudflare Worker, and the DNS check takes its lookup from the
// caller for exactly that reason.

// Hosts that publish calendars. A suffix match, anchored so that
// "icloud.com.evil.test" cannot pass as iCloud.
export const ALLOWED_HOSTS = [
  "icloud.com",
  "me.com",
  "mac.com",
  "calendar.google.com",
  "google.com",
  "googleusercontent.com",
  "outlook.office365.com",
  "outlook.office.com",
  "outlook.live.com",
  "calendar.yahoo.com",
  "fastmail.com",
  "zoho.com",
  "nextcloud.com",
];

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 4;
export const FETCH_TIMEOUT_MS = 20_000;

export function hostAllowed(hostname, allowed = ALLOWED_HOSTS) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// Private, loopback, link-local and carrier-grade-NAT space, in both families.
// The cloud metadata endpoint at 169.254.169.254 is inside the link-local range.
export function isPrivateAddress(ip) {
  const addr = String(ip || "").trim().toLowerCase();
  if (!addr) return true;

  if (addr.includes(":")) {
    if (addr === "::" || addr === "::1") return true;
    if (/^fe[89ab]/.test(addr)) return true; // link-local
    if (/^f[cd]/.test(addr)) return true;    // unique-local
    // ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 coat
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // not an address we can reason about
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true;                         // multicast and reserved
  return false;
}

// A caller-supplied address turned into something safe to fetch, or an
// explanation of why not. webcal:// is accepted because that is what the
// calendar hands the user; it is https underneath.
export function normalizeTarget(input, allowed = ALLOWED_HOSTS) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "no url given" };
  if (raw.length > 2048) return { ok: false, error: "url too long" };

  const withScheme = /^webcals?:\/\//i.test(raw) ? raw.replace(/^webcals?:/i, "https:") : raw;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "not a url" };
  }

  if (url.protocol !== "https:") return { ok: false, error: "https only" };
  if (url.username || url.password) return { ok: false, error: "credentials not allowed" };
  if (!hostAllowed(url.hostname, allowed)) {
    return { ok: false, error: "that host is not a known calendar service" };
  }

  return { ok: true, url: url.toString(), hostname: url.hostname };
}

// The hostname may be allowed and still resolve somewhere it should not, either
// by accident or because someone pointed a record at a private address. Check
// what it actually resolves to before trusting it.
//
// `lookup` must be supplied — on Node that is dns.lookup; a Worker has no DNS
// API and no route to a private network in the first place, so it skips this.
export async function resolvesPublicly(hostname, lookup) {
  if (typeof lookup !== "function") return false;
  try {
    const records = await lookup(hostname, { all: true });
    const list = Array.isArray(records) ? records : [records];
    if (!list.length) return false;
    return list.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

// Which origins may read the response. "*" is deliberately available: the proxy
// returns a public calendar and holds no credentials or cookies, so there is
// nothing for another site to steal by reading it. Setting ALLOWED_ORIGINS
// narrows it anyway, which is worth doing to keep the service to its own app.
export function originAllowed(origin, allowList) {
  if (!allowList || allowList === "*") return "*";
  const allowed = String(allowList)
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const want = String(origin || "").trim().replace(/\/+$/, "");
  return want && allowed.includes(want) ? want : "";
}
