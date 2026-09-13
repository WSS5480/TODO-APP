import { defineConfig } from "vite";

// Stamped into the bundle and written to version.json, so a running copy of the
// app can tell whether the server has a newer build than the one it is running.
const BUILD_VERSION = process.env.BUILD_VERSION || String(Date.now());

function emitVersion() {
  return {
    name: "emit-version",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version: BUILD_VERSION }) + "\n",
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [emitVersion()],
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_VERSION),
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
