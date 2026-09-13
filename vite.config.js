import { createHash } from "node:crypto";
import { defineConfig } from "vite";

// Placeholders swapped for the real values while the bundle is generated. Both
// the stamp compiled into the app and the one written to version.json come from
// that single computation, so the two can never disagree — if they did, the app
// would believe it was permanently out of date.
const VERSION_TOKEN = "__BUILD_VERSION__";
const BUILT_AT_TOKEN = "__BUILD_TIME__";

function versionStamp() {
  return {
    name: "version-stamp",
    generateBundle(_options, bundle) {
      // Derive the version from the build's own output rather than a clock, so
      // an unchanged build keeps its version and cannot nag about itself.
      const hash = createHash("sha256");
      for (const name of Object.keys(bundle).sort()) {
        const file = bundle[name];
        hash.update(name);
        hash.update(file.type === "asset" ? file.source : file.code);
      }
      const version = hash.digest("hex").slice(0, 12);
      const builtAt = String(Date.now());

      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;
        file.code = file.code
          .split(VERSION_TOKEN).join(version)
          .split(BUILT_AT_TOKEN).join(builtAt);
      }

      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version, builtAt }) + "\n",
      });
    },
  };
}

export default defineConfig({
  // Served from the domain root. Absolute paths matter here: with "./" Vite
  // rewrites every icon and manifest href to a relative one, and iOS failed to
  // resolve the manifest's icons, falling back to a generated letter tile.
  base: "/",
  plugins: [versionStamp()],
  define: {
    __APP_VERSION__: JSON.stringify(VERSION_TOKEN),
    __APP_BUILT_AT__: JSON.stringify(BUILT_AT_TOKEN),
  },
  test: {
    environment: "jsdom",
    globals: true,
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.js", "src/main.js"],
    },
  },
});
