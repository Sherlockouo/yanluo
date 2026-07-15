import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { codeInspectorPlugin } from "code-inspector-plugin";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * HeroUI v3 official Vite setup:
 * - @tailwindcss/vite only (no PostCSS Tailwind plugin)
 * - CSS: @import "tailwindcss"; @import "@heroui/styles";
 * See: https://github.com/heroui-inc/vite-template
 */
export default defineConfig({
  plugins: [
    codeInspectorPlugin({
      bundler: "vite",
    }),
    react(),
    tailwindcss(),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    // LightningCSS minify can corrupt Tailwind v4 nested :where(&) selectors.
    cssMinify: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
