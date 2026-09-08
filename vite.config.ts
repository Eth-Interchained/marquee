import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { portalPlugin } from "@interchained/portal-core/vite";

/**
 * Portal's `@portal/routes` virtual module emits relative specifiers that
 * Vite 5.4 can't resolve from a `\0virtual:` importer. Rewrite them to
 * absolute paths — scoped to that virtual module only. (Same shim as
 * nedb-links; upstream fix pending in portal-core.)
 */
function portalRouteResolver(): Plugin {
  let root = process.cwd();
  return {
    name: "portal-virtual-route-resolver",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    resolveId(source, importer) {
      if (importer && importer.includes("@portal/routes") && (source.startsWith("./") || source.startsWith("../"))) {
        return resolve(root, source);
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.MARQUEE_API_PORT || "3401";
  const clientPort = Number(env.VITE_PORT || 3400);
  return {
    plugins: [portalRouteResolver(), portalPlugin(), react()],
    resolve: { alias: { "@": resolve(process.cwd(), "src") } },
    server: {
      port: clientPort,
      host: true,
      proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
    },
    preview: { port: clientPort, host: true },
    build: { outDir: "dist", sourcemap: true },
  };
});
