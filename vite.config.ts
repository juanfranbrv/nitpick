import { defineConfig } from "vite";
import { resolve } from "path";

// Tauri drives this dev server; fail loudly instead of hopping ports so the
// Rust side always knows where the frontend lives.
export default defineConfig({
  clearScreen: false,
  server: { port: 5183, strictPort: true },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
      },
    },
  },
});
