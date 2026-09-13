// Detecting a new build.
//
// Installed to a Home Screen there is no reload button and no service worker, so
// the app can sit on a cached index.html indefinitely — the reason a new version
// otherwise only arrives by deleting and reinstalling it. Every build stamps a
// version into the bundle and writes the same value to version.json, so a
// running copy can ask the server whether it is out of date.

/* global __APP_VERSION__ */

// Vite's define replaces this at build time; guard it so the module still loads
// under a bare test runner or a dev server that skipped the define.
export const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export function isOutdated(latest, current = APP_VERSION) {
  // Unknown or unchanged means nothing to offer. Any difference counts as newer:
  // versions are build stamps, not an ordered series, so a rollback is an update too.
  return Boolean(latest) && Boolean(current) && latest !== current;
}

// Read the deployed build's version, defeating every layer of cache we can:
// a unique query string, no-store, and reload semantics.
export async function fetchDeployedVersion(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const res = await fetchImpl(`version.json?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return typeof data?.version === "string" ? data.version : null;
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
