import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
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
