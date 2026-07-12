import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Versión visible en la app: hash corto de git + fecha de build (para control de versiones).
const APP_VERSION = (() => {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    return `${new Date().toISOString().slice(0, 10)} · ${sha}`;
  } catch {
    return "dev";
  }
})();

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Inyecta el handler de Web Push (public/push-sw.js) en el SW generado.
      workbox: { importScripts: ["push-sw.js"] },
      manifest: {
        name: "Smartkids · Órbita",
        short_name: "Smartkids",
        description: "Aprende explorando la galaxia",
        lang: "es",
        theme_color: "#0A0D1F",
        background_color: "#0A0D1F",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"],
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // En local, /api/* se proxya al Worker de wrangler dev (puerto 8787).
      "/api": "http://localhost:8787",
    },
  },
});
