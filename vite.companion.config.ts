import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/companion"),
  publicDir: resolve(__dirname, "src/companion/public"),
  base: "/",
  build: {
    outDir: resolve(__dirname, "dist/companion"),
    emptyOutDir: true,
    sourcemap: false,
    target: "safari15",
    rollupOptions: { input: resolve(__dirname, "src/companion/index.html") },
  },
});
