#!/usr/bin/env node
/**
 * Stage mlx.metallib next to the Yanluo binary (and for .app bundling).
 *
 * MLX loads shaders via dladdr → Contents/MacOS/mlx.metallib (or beside cargo
 * target/{debug,release}/yanluo). Without this file it falls back to a
 * compile-time absolute METAL_PATH from the build machine (CI: /Users/runner/...).
 *
 * Usage:
 *   node scripts/stage-mlx-metallib.mjs           # best-effort (dev)
 *   node scripts/stage-mlx-metallib.mjs --bundle  # for beforeBundleCommand
 *   node scripts/stage-mlx-metallib.mjs --require # fail if missing
 *   node scripts/stage-mlx-metallib.mjs --app /path/to/Yanluo.app
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcTauri = path.join(root, "src-tauri");
const generatedDir = path.join(srcTauri, "generated");
const generatedLib = path.join(generatedDir, "mlx.metallib");

const args = new Set(process.argv.slice(2));
const requireLib = args.has("--require") || args.has("--bundle");
const appIdx = process.argv.indexOf("--app");
const appPath = appIdx >= 0 ? process.argv[appIdx + 1] : null;

function isDarwin() {
  return process.platform === "darwin";
}

function findMetallib() {
  const candidates = [];
  for (const profile of ["release", "debug"]) {
    const buildRoot = path.join(srcTauri, "target", profile, "build");
    if (!fs.existsSync(buildRoot)) continue;
    for (const ent of fs.readdirSync(buildRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith("qwen3-asr-rs-")) continue;
      const lib = path.join(buildRoot, ent.name, "out", "lib", "mlx.metallib");
      if (fs.existsSync(lib)) {
        const st = fs.statSync(lib);
        candidates.push({ lib, mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.lib ?? null;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[mlx-metallib] ${src} → ${dest}`);
}

function stageBesideBinaries(src) {
  for (const profile of ["release", "debug"]) {
    const binDir = path.join(srcTauri, "target", profile);
    if (!fs.existsSync(binDir)) continue;
    // Next to cargo / tauri binary (dladdr parent).
    copyFile(src, path.join(binDir, "mlx.metallib"));
  }
}

function stageIntoApp(src, app) {
  const dest = path.join(app, "Contents", "MacOS", "mlx.metallib");
  if (!fs.existsSync(path.join(app, "Contents", "MacOS"))) {
    console.error(`[mlx-metallib] not an .app bundle: ${app}`);
    process.exit(1);
  }
  copyFile(src, dest);
}

function main() {
  if (!isDarwin() && !appPath) {
    console.log("[mlx-metallib] skip (not macOS)");
    return;
  }

  const src = findMetallib();
  if (!src) {
    if (requireLib) {
      console.error(
        "[mlx-metallib] mlx.metallib not found under target/*/build/qwen3-asr-rs-*/out/lib/\n" +
          "  Build with: pnpm tauri build --features qwen-local\n" +
          "  (Metal Toolchain required — see doc/BUILD.md)",
      );
      process.exit(1);
    }
    console.warn("[mlx-metallib] not found — skip (Apple Speech / non-qwen build)");
    return;
  }

  fs.mkdirSync(generatedDir, { recursive: true });
  copyFile(src, generatedLib);
  stageBesideBinaries(src);

  if (appPath) {
    stageIntoApp(src, appPath);
  }

  // Also patch any already-bundled apps under target/release/bundle/macos.
  const bundleMac = path.join(srcTauri, "target", "release", "bundle", "macos");
  if (fs.existsSync(bundleMac)) {
    for (const name of fs.readdirSync(bundleMac)) {
      if (!name.endsWith(".app")) continue;
      stageIntoApp(src, path.join(bundleMac, name));
    }
  }
}

main();
