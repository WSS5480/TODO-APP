import { describe, it, expect, vi } from "vitest";
import { isOutdated, fetchDeployedVersion, reloadToVersion } from "./update.js";

const ok = (body) => ({ ok: true, json: async () => body });
const build = (version, builtAt) => ({ version, builtAt });

describe("isOutdated", () => {
  it("is true only when the deployed build is newer", () => {
    expect(isOutdated(build("b", 2000), 1000)).toBe(true);
  });

  it("ignores a stale answer from an older build", () => {
    // The bug this guards: a CDN or installed app can keep serving version.json
    // from an earlier deploy. Comparing for mere inequality treats that as an
    // update on every check and pins the banner on screen forever.
    expect(isOutdated(build("older", 1000), 2000)).toBe(false);
  });

  it("is false for the build we are already running", () => {
    expect(isOutdated(build("same", 1000), 1000)).toBe(false);
  });

  it("is false when the payload is missing or malformed", () => {
    expect(isOutdated(null, 1000)).toBe(false);
    expect(isOutdated({}, 1000)).toBe(false);
    expect(isOutdated(build(null, 2000), 1000)).toBe(false);
    expect(isOutdated(build("b", "not-a-number"), 1000)).toBe(false);
  });

  it("stays quiet when this build has no stamp of its own", () => {
    // a dev server build cannot know whether it is behind, so it never nags
    expect(isOutdated(build("b", 2000), 0)).toBe(false);
  });
});

describe("fetchDeployedVersion", () => {
  it("reads the stamp and defeats caching", async () => {
    const fetchImpl = vi.fn(async () => ok({ version: "abc", builtAt: "1700" }));
    expect(await fetchDeployedVersion(fetchImpl)).toEqual({ version: "abc", builtAt: 1700 });

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/^version\.json\?t=\d+/); // unique each time
    expect(opts.cache).toBe("no-store");
  });

  it("returns null on a failed response", async () => {
    expect(await fetchDeployedVersion(async () => ({ ok: false }))).toBeNull();
  });

  it("returns null when offline rather than throwing", async () => {
    const boom = async () => { throw new Error("offline"); };
    await expect(fetchDeployedVersion(boom)).resolves.toBeNull();
  });

  it("returns null when the payload has no version", async () => {
    expect(await fetchDeployedVersion(async () => ok({}))).toBeNull();
    expect(await fetchDeployedVersion(async () => ok({ version: 7 }))).toBeNull();
  });

  it("returns null when there is no fetch at all", async () => {
    expect(await fetchDeployedVersion(undefined)).toBeNull();
  });
});

describe("reloadToVersion", () => {
  it("replaces onto a URL the cache has not seen", () => {
    const location = { pathname: "/", hash: "", replace: vi.fn() };
    reloadToVersion("123", location);
    expect(location.replace).toHaveBeenCalledWith("/?v=123");
  });

  it("keeps the path and hash", () => {
    const location = { pathname: "/app/", hash: "#x", replace: vi.fn() };
    reloadToVersion("a b", location);
    expect(location.replace).toHaveBeenCalledWith("/app/?v=a%20b#x");
  });
});
