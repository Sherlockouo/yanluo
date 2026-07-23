#!/usr/bin/env node
/**
 * Copy libtorch shared libs next to the release binary / into bundle dirs
 * so AppImage / deb / msi / nsis can load them without a system install.
 *
 * Usage (beforeBundleCommand on Linux/Windows):
 *   node scripts/stage-libtorch.mjs --bundle
 *
 * Expects src-tauri/libtorch from fetch-libtorch.mjs and LIBTORCH env at build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcTauri = path.join(root, "src-tauri");
const libtorch = process.env.LIBTORCH
  ? path.resolve(process.env.LIBTORCH)
  : path.join(srcTauri, "libtorch");
const libDir = path.join(libtorch, "lib");

const requireBundle = process.argv.includes("--bundle") || process.argv.includes("--require");

function isUnix() {
  return process.platform === "linux" || process.platform === "darwin";
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function targetReleaseDirs() {
  const dirs = [];
  const envTarget = process.env.CARGO_TARGET_DIR;
  const roots = [];
  if (envTarget) roots.push(path.resolve(envTarget));
  roots.push(path.join(srcTauri, "target"));
  for (const rootDir of roots) {
    const release = path.join(rootDir, "release");
    if (fs.existsSync(release)) dirs.push(release);
    // cross / triple layouts
    try {
      for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const rel = path.join(rootDir, ent.name, "release");
        if (fs.existsSync(rel)) dirs.push(rel);
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(dirs)];
}

function main() {
  if (process.platform === "darwin") {
    console.log("[stage-libtorch] skip on macOS");
    return;
  }
  if (!fs.existsSync(libDir)) {
    const msg = `[stage-libtorch] missing ${libDir} — run: node scripts/fetch-libtorch.mjs`;
    if (requireBundle) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg);
    return;
  }

  const releaseDirs = targetReleaseDirs();
  if (releaseDirs.length === 0) {
    console.warn("[stage-libtorch] no target/release dir yet");
  }

  for (const release of releaseDirs) {
    const dest = path.join(release, "libtorch");
    console.log(`[stage-libtorch] ${libtorch} → ${dest}`);
    fs.rmSync(dest, { recursive: true, force: true });
    copyTree(libtorch, dest);

    // Also flatten shared libs next to the binary (helps Windows + some AppImages).
    const flat = path.join(release, "torch-libs");
    fs.rmSync(flat, { recursive: true, force: true });
    fs.mkdirSync(flat, { recursive: true });
    for (const name of fs.readdirSync(libDir)) {
      const from = path.join(libDir, name);
      if (!fs.statSync(from).isFile()) continue;
      if (isUnix() && !/\.so(\.|$)/.test(name) && !name.endsWith(".dylib")) continue;
      if (process.platform === "win32" && !/\.dll$/i.test(name)) continue;
      fs.copyFileSync(from, path.join(flat, name));
    }
    console.log(`[stage-libtorch] flat libs → ${flat}`);
  }
}

main();
