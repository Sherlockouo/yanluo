import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { codeInspectorPlugin } from "code-inspector-plugin";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    codeInspectorPlugin({
      bundler: "vite",
    }),
    react(),
    tailwindcss(),
  ],
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
    // Avoid LightningCSS mangling Tailwind v4 nested :where(&) selectors
    // (space-y / divide utilities become invalid and are dropped by the browser).
    cssMinify: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
