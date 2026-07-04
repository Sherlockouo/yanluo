import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  // Prevent vite from obscuring rust error messages
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri uses Chromium on Windows/Linux, WebKit on macOS
    target: "esnext",
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
