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
        // TODO: añadir iconos (192/512 + maskable) en public/ y referenciarlos aquí.
        icons: [],
      },
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
