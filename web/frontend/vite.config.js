import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    proxy: {
      "/api": "http://localhost:8420",
      "/ws": {
        target: "ws://localhost:8420",
        ws: true,
        // Suppress ECONNABORTED noise when WS connections drop during HMR/reload
        configure: (proxy) => {
          proxy.on("error", (err) => {
            if (err.code !== "ECONNABORTED" && err.code !== "ECONNRESET") {
              console.error("[ws proxy]", err.message);
            }
          });
        },
      },
      "/login": "http://localhost:8420",
      "/logout": "http://localhost:8420",
      "/auth": "http://localhost:8420",
    },
  },
});
