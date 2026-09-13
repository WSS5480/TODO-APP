import { describe, it, expect, vi } from "vitest";
import { APP_VERSION, isOutdated, fetchDeployedVersion, reloadToVersion } from "./update.js";

const ok = (body) => ({ ok: true, json: async () => body });

describe("isOutdated", () => {
  it("is true when the deployed build differs from this one", () => {
    expect(isOutdated("200", "100")).toBe(true);
  });

  it("treats a rollback as an update too", () => {
    // versions are build stamps, not an ordered series
    expect(isOutdated("100", "200")).toBe(true);
  });

  it("is false when they match", () => {
    expect(isOutdated("100", "100")).toBe(false);
  });

  it("is false when either side is unknown", () => {
    expect(isOutdated(null, "100")).toBe(false);
    expect(isOutdated("", "100")).toBe(false);
    expect(isOutdated("100", "")).toBe(false);
  });

  it("compares against the built-in version by default", () => {
    expect(isOutdated(APP_VERSION)).toBe(false);
    expect(isOutdated(APP_VERSION + "-x")).toBe(true);
  });
});

describe("fetchDeployedVersion", () => {
  it("reads the version and defeats caching", async () => {
    const fetchImpl = vi.fn(async () => ok({ version: "abc" }));
    expect(await fetchDeployedVersion(fetchImpl)).toBe("abc");

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
