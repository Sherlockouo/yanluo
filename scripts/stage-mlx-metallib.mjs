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
 *   node scripts/stage-mlx-metallib.mjs --bundle  # for beforeBundleCommand (required)
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

function targetRoots() {
  const roots = [];
  const envTarget = process.env.CARGO_TARGET_DIR;
  if (envTarget) roots.push(path.resolve(envTarget));
  roots.push(path.join(srcTauri, "target"));
  return [...new Set(roots)].filter((p) => fs.existsSync(p));
}

/** Prefer out/lib/mlx.metallib; accept any mlx.metallib under qwen3-asr-rs build outs. */
function findMetallib() {
  const candidates = [];

  function consider(lib) {
    try {
      const st = fs.statSync(lib);
      if (!st.isFile() || st.size < 1024) return;
      const norm = lib.replace(/\\/g, "/");
      const rank =
        (norm.includes("/out/lib/mlx.metallib") ? 3 : 0) +
        (norm.includes("/qwen3-asr-rs-") ? 1 : 0) +
        (norm.includes("/lib/") ? 1 : 0);
      candidates.push({ lib, mtime: st.mtimeMs, size: st.size, rank });
    } catch {
      /* ignore */
    }
  }

  function walk(dir, depth) {
    if (depth > 10) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === "mlx.metallib") {
        consider(full);
        continue;
      }
      if (!ent.isDirectory()) continue;
      const n = ent.name;
      // Skip huge irrelevant trees.
      if (n === ".git" || n === "incremental" || n === "deps" || n === "examples") continue;
      if (
        n === "build" ||
        n === "out" ||
        n === "lib" ||
        n === "release" ||
        n === "debug" ||
        n === "metal" ||
        n === "kernels" ||
        n.startsWith("qwen3-asr-rs-") ||
        n.includes("mlx") ||
        n.includes("apple") ||
        n.includes("darwin")
      ) {
        walk(full, depth + 1);
      } else if (depth <= 2) {
        // target/<triple>/{release,debug}
        walk(full, depth + 1);
      }
    }
  }

  for (const root of targetRoots()) {
    // Fast path: classic layout.
    for (const profile of ["release", "debug"]) {
      const buildRoot = path.join(root, profile, "build");
      if (!fs.existsSync(buildRoot)) continue;
      for (const ent of fs.readdirSync(buildRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith("qwen3-asr-rs-")) continue;
        consider(path.join(buildRoot, ent.name, "out", "lib", "mlx.metallib"));
      }
    }
    walk(root, 0);
  }

  candidates.sort((a, b) => b.rank - a.rank || b.mtime - a.mtime || b.size - a.size);
  return candidates[0]?.lib ?? null;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[mlx-metallib] ${src} → ${dest}`);
}

function stageBesideBinaries(src) {
  for (const root of targetRoots()) {
    for (const profile of ["release", "debug"]) {
      const binDir = path.join(root, profile);
      if (!fs.existsSync(binDir)) continue;
      copyFile(src, path.join(binDir, "mlx.metallib"));
      // target/<triple>/<profile>/
      try {
        for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const tripleProfile = path.join(root, ent.name, profile);
          if (fs.existsSync(tripleProfile)) {
            copyFile(src, path.join(tripleProfile, "mlx.metallib"));
          }
        }
      } catch {
        /* ignore */
      }
    }
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
        "[mlx-metallib] mlx.metallib not found under target/**/qwen3-asr-rs-*/\n" +
          "  Build with: pnpm tauri build --features qwen-local\n" +
          "  (Metal Toolchain required — see doc/BUILD.md)",
      );
      process.exit(1);
    }
    console.warn("[mlx-metallib] not found — skip (Apple Speech / non-qwen build)");
    return;
  }

  console.log(`[mlx-metallib] using ${src}`);
  fs.mkdirSync(generatedDir, { recursive: true });
  copyFile(src, generatedLib);
  stageBesideBinaries(src);

  if (appPath) {
    stageIntoApp(src, appPath);
  }

  // Patch already-bundled apps under target/**/bundle/macos.
  for (const root of targetRoots()) {
    const bundleMac = path.join(root, "release", "bundle", "macos");
    if (!fs.existsSync(bundleMac)) continue;
    for (const name of fs.readdirSync(bundleMac)) {
      if (!name.endsWith(".app")) continue;
      stageIntoApp(src, path.join(bundleMac, name));
    }
  }
}

main();
