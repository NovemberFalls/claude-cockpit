import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": "http://localhost:8430",
      "/ws": {
        target: "ws://localhost:8430",
        ws: true,
      },
      "/tunnel": {
        target: "ws://localhost:8430",
        ws: true,
      },
      "/login": "http://localhost:8430",
      "/logout": "http://localhost:8430",
      "/auth": "http://localhost:8430",
    },
  },
});
