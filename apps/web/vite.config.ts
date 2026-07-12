import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "smartkids · Órbita",
        short_name: "smartkids",
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
