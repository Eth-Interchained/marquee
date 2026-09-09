import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, rm } from "node:fs/promises";
import { build } from "esbuild";

const shellDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(shellDir, "dist");
const from = (...parts) => path.resolve(shellDir, ...parts);

await rm(distDir, { recursive: true, force: true });

// Main process and preloads are CommonJS: Electron's sandboxed preload loader
// only understands CJS, and `electron` itself is resolved by the runtime.
const nodeSide = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: "linked",
  outdir: distDir,
  outExtension: { ".js": ".cjs" },
  logLevel: "info",
};

await build({
  ...nodeSide,
  entryPoints: { main: from("src/main.ts") },
});

await build({
  ...nodeSide,
  entryPoints: {
    "preload-privileged": from("src/preload/privileged.ts"),
    "preload-toolbar": from("src/preload/toolbar.ts"),
  },
});

// The toolbar is ordinary browser code loaded by a <script> tag.
await build({
  bundle: true,
  platform: "browser",
  target: "chrome130",
  format: "iife",
  entryPoints: { toolbar: from("src/renderer/toolbar.ts") },
  outdir: distDir,
  sourcemap: "linked",
  logLevel: "info",
});

await cp(from("src/renderer/toolbar.html"), path.join(distDir, "toolbar.html"));

// The app icon travels with the build for the same reason the toolbar's HTML
// does: the main process resolves everything it needs from `__dirname`.
await cp(from("assets/icon.png"), path.join(distDir, "icon.png"));
