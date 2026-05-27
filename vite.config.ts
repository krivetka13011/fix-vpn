import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Cloudflare Assets не отдаёт CORS — module/script с crossorigin не грузится */
function stripCrossorigin(): Plugin {
  return {
    name: "strip-crossorigin",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(="[^"]*")?/g, "");
    },
  };
}

export default defineConfig({
  plugins: [react(), stripCrossorigin()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
