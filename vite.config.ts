import { defineConfig } from "vite";

// The bundle is served by the Anna host from a nested path
// (/anna-apps/<slug>/dev/ in the dev harness, a CDN path in
// production) — never from the domain root. All asset URLs in the
// built HTML must therefore be relative ("./assets/…"), not absolute.
export default defineConfig({
  base: "./",
  build: {
    outDir: "bundle",
    emptyOutDir: true,
    target: "es2020",
  },
});
