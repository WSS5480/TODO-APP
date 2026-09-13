// Detecting a new build.
//
// Installed to a Home Screen there is no reload button and no service worker, so
// the app can sit on a cached index.html indefinitely — the reason a new version
// otherwise only arrives by deleting and reinstalling it. Every build stamps a
// version and a build time into the bundle and writes the same pair to
// version.json, so a running copy can ask the server whether it is out of date.

/* global __APP_VERSION__, __APP_BUILT_AT__ */

// Vite's define replaces these at build time; guard them so the module still
// loads under a bare test runner or a dev server that skipped the define.
export const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const APP_BUILT_AT =
  typeof __APP_BUILT_AT__ === "string" ? Number(__APP_BUILT_AT__) || 0 : 0;

// Only a strictly newer build counts.
//
// Comparing versions for mere inequality looks right and is not: a CDN or an
// installed app can answer with a cached copy of version.json from an older
// deploy, and "different" then reads as "newer" on every single check, pinning
// the update banner on screen permanently. A build time makes the comparison
// directional, so a stale answer is simply ignored.
export function isOutdated(deployed, builtAt = APP_BUILT_AT) {
  if (!deployed || typeof deployed.version !== "string") return false;
  const theirs = Number(deployed.builtAt);
  if (!Number.isFinite(theirs) || !builtAt) return false;
  return theirs > builtAt;
}

// Read the deployed build's stamp, defeating every layer of cache we can.
export async function fetchDeployedVersion(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const res = await fetchImpl(`version.json?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (typeof data?.version !== "string") return null;
    return { version: data.version, builtAt: Number(data.builtAt) || 0 };
  } catch {
    // Offline, or running from a dev server with no version.json: not an error.
    return null;
  }
}

// Reload onto a URL the cache has never seen, so the stale index.html cannot be
// served again. Asset filenames are content-hashed, so they follow automatically.
export function reloadToVersion(version, location = globalThis.location) {
  const url = `${location.pathname}?v=${encodeURIComponent(version)}${location.hash || ""}`;
  location.replace(url);
}
