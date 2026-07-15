#!/usr/bin/env node
/**
 * Source of truth: package.json "version".
 * Syncs → src-tauri/Cargo.toml + src-tauri/tauri.conf.json
 *
 * Usage: node scripts/sync-version.mjs
 *        node scripts/sync-version.mjs --check   # exit 1 if out of sync
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const pkgPath = path.join(root, "package.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = String(pkg.version || "").trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid package.json version: ${version}`);
  process.exit(1);
}

const cargo = fs.readFileSync(cargoPath, "utf8");
const cargoMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m);
const cargoVersion = cargoMatch?.[1] ?? "";

const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
const confVersion = String(conf.version || "");

if (checkOnly) {
  const ok = cargoVersion === version && confVersion === version;
  if (!ok) {
    console.error(
      `Version mismatch: package.json=${version} Cargo.toml=${cargoVersion} tauri.conf.json=${confVersion}`,
    );
    console.error("Run: pnpm version:sync");
    process.exit(1);
  }
  console.log(`OK ${version}`);
  process.exit(0);
}

const nextCargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
if (nextCargo === cargo && cargoVersion !== version) {
  console.error("Failed to patch Cargo.toml version");
  process.exit(1);
}
fs.writeFileSync(cargoPath, nextCargo);

conf.version = version;
fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

console.log(`Synced version ${version} → Cargo.toml, tauri.conf.json`);
console.log(`Tag with: git tag v${version} && git push origin v${version}`);
