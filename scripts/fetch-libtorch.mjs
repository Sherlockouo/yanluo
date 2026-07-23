#!/usr/bin/env node
/**
 * Download libtorch for Linux/Windows local Qwen (tch-backend).
 *
 * Usage:
 *   node scripts/fetch-libtorch.mjs              # CPU (default)
 *   node scripts/fetch-libtorch.mjs --cuda       # CUDA 12.6 (Linux NVIDIA / Win)
 *   node scripts/fetch-libtorch.mjs --force      # re-download
 *
 * Env:
 *   LIBTORCH_VARIANT=cpu|cuda   (overrides --cuda)
 *   LIBTORCH_DIR=...            install root (default: src-tauri/libtorch)
 *
 * After fetch:
 *   export LIBTORCH=$PWD/src-tauri/libtorch
 *   export LIBTORCH_BYPASS_VERSION_CHECK=1
 */
import fs from "node:fs";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcTauri = path.join(root, "src-tauri");

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const wantCuda =
  process.env.LIBTORCH_VARIANT === "cuda" ||
  (process.env.LIBTORCH_VARIANT !== "cpu" && args.has("--cuda"));

const outDir = process.env.LIBTORCH_DIR
  ? path.resolve(process.env.LIBTORCH_DIR)
  : path.join(srcTauri, "libtorch");

const SECOND_STATE = "https://github.com/second-state/libtorch-releases/releases/download/v2.7.1";
const PYTORCH = "https://download.pytorch.org/libtorch";

function assetFor() {
  const plat = process.platform;
  const arch = process.arch; // x64 | arm64
  if (plat === "linux") {
    if (arch === "arm64") {
      return wantCuda
        ? {
            url: `${SECOND_STATE}/libtorch-cxx11-abi-aarch64-cuda12.6-2.7.1.tar.gz`,
            kind: "tar.gz",
          }
        : {
            url: `${SECOND_STATE}/libtorch-cxx11-abi-aarch64-2.7.1.tar.gz`,
            kind: "tar.gz",
          };
    }
    return wantCuda
      ? {
          url: `${SECOND_STATE}/libtorch-cxx11-abi-x86_64-cuda12.6-2.7.1.tar.gz`,
          kind: "tar.gz",
        }
      : {
          url: `${SECOND_STATE}/libtorch-cxx11-abi-x86_64-2.7.1.tar.gz`,
          kind: "tar.gz",
        };
  }
  if (plat === "win32") {
    // Official PyTorch Windows builds (second-state has Linux only).
    return wantCuda
      ? {
          url: `${PYTORCH}/cu126/libtorch-win-shared-with-deps-2.7.1%2Bcu126.zip`,
          kind: "zip",
        }
      : {
          url: `${PYTORCH}/cpu/libtorch-win-shared-with-deps-2.7.1%2Bcpu.zip`,
          kind: "zip",
        };
  }
  throw new Error(
    `fetch-libtorch: unsupported platform ${plat}/${arch} (macOS uses MLX, not libtorch)`,
  );
}

function markerPath() {
  return path.join(outDir, ".yanluo-libtorch-variant");
}

function alreadyOk(variant) {
  if (force) return false;
  const libDir = path.join(outDir, "lib");
  if (!fs.existsSync(libDir)) return false;
  try {
    const prev = fs.readFileSync(markerPath(), "utf8").trim();
    return prev === variant;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  console.log(`[fetch-libtorch] downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extract(archive, kind, destParent) {
  fs.mkdirSync(destParent, { recursive: true });
  if (kind === "tar.gz") {
    execFileSync("tar", ["xzf", archive, "-C", destParent], { stdio: "inherit" });
    return;
  }
  if (kind === "zip") {
    if (process.platform === "win32") {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destParent.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("unzip", ["-qo", archive, "-d", destParent], { stdio: "inherit" });
    }
  }
}

async function main() {
  if (process.platform === "darwin") {
    console.log("[fetch-libtorch] skip on macOS (MLX backend)");
    return;
  }
  const variant = wantCuda ? "cuda" : "cpu";
  if (alreadyOk(variant)) {
    console.log(`[fetch-libtorch] reuse ${outDir} (${variant})`);
    console.log(`export LIBTORCH=${outDir}`);
    console.log("export LIBTORCH_BYPASS_VERSION_CHECK=1");
    return;
  }

  const { url, kind } = assetFor();
  const tmpRoot = path.join(srcTauri, ".libtorch-tmp");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  const archive = path.join(tmpRoot, kind === "zip" ? "libtorch.zip" : "libtorch.tar.gz");

  await download(url, archive);
  extract(archive, kind, tmpRoot);

  // Archive contains top-level `libtorch/`
  const extracted = path.join(tmpRoot, "libtorch");
  if (!fs.existsSync(extracted)) {
    throw new Error(`extract missing ${extracted}`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(extracted, outDir);
  fs.writeFileSync(markerPath(), `${variant}\n`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`[fetch-libtorch] ready ${outDir} (${variant})`);
  console.log(`export LIBTORCH=${outDir}`);
  console.log("export LIBTORCH_BYPASS_VERSION_CHECK=1");
  if (wantCuda) {
    console.log(
      "[fetch-libtorch] CUDA build: runtime needs NVIDIA driver + CUDA 12.x libs on PATH/LD_LIBRARY_PATH",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
