#!/usr/bin/env node
/**
 * Put Gatekeeper-fix .command next to Yanluo.app and inside the DMG volume.
 *
 * Usage (after `pnpm tauri build --bundles app,dmg`):
 *   node scripts/embed-gatekeeper-fix.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcTauri = path.join(root, "src-tauri");
const scriptSrc = path.join(root, "packaging", "若打不开-点我.command");
const scriptName = "若打不开-点我.command";

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    ...opts,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${err || r.status}`);
  }
  return r.stdout || "";
}

function targetRoots() {
  const roots = [];
  if (process.env.CARGO_TARGET_DIR) roots.push(path.resolve(process.env.CARGO_TARGET_DIR));
  roots.push(path.join(srcTauri, "target"));
  return [...new Set(roots)].filter((p) => fs.existsSync(p));
}

function findApps() {
  const apps = [];
  for (const root of targetRoots()) {
    const dir = path.join(root, "release", "bundle", "macos");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name === "Yanluo.app" || name === "QuietType.app") {
        apps.push(path.join(dir, name));
      }
    }
  }
  return apps;
}

function findDmgs() {
  const dmgs = [];
  for (const root of targetRoots()) {
    const dir = path.join(root, "release", "bundle", "dmg");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".dmg") || name.startsWith("rw.")) continue;
      if (!name.startsWith("Yanluo_") && !name.startsWith("QuietType_")) continue;
      dmgs.push(path.join(dir, name));
    }
  }
  return dmgs;
}

function stageBesideApp(appPath) {
  const dest = path.join(path.dirname(appPath), scriptName);
  fs.copyFileSync(scriptSrc, dest);
  fs.chmodSync(dest, 0o755);
  // Clear quarantine on the helper itself so double-click works from Finder.
  try {
    sh("xattr", ["-cr", dest]);
  } catch {
    /* ignore */
  }
  console.log(`[gatekeeper-fix] beside app → ${dest}`);
  return dest;
}

function embedIntoDmg(dmgPath) {
  const abs = path.resolve(dmgPath);
  const tmpRw = path.join(path.dirname(abs), `rw.${path.basename(abs)}`);
  const mountRoot = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "yanluo-dmg-"));

  console.log(`[gatekeeper-fix] embedding into ${abs}`);

  try {
    if (fs.existsSync(tmpRw)) fs.unlinkSync(tmpRw);

    // Read-only UDZO → writable UDRW clone.
    sh("hdiutil", ["convert", abs, "-format", "UDRW", "-o", tmpRw]);

    const attachOut = sh("hdiutil", [
      "attach",
      tmpRw,
      "-readwrite",
      "-noverify",
      "-noautoopen",
      "-mountroot",
      mountRoot,
    ]);
    // mount point: last column of `/dev/diskXsY  ...  /tmp/.../VolumeName`
    const lines = attachOut.split("\n").filter(Boolean);
    let volume = null;
    for (const line of lines) {
      const m = line.match(/(\/.*\S)\s*$/);
      if (m && fs.existsSync(m[1]) && fs.statSync(m[1]).isDirectory()) {
        volume = m[1];
      }
    }
    if (!volume) {
      // Fallback: only dir under mountRoot
      const kids = fs.readdirSync(mountRoot);
      if (kids.length === 1) volume = path.join(mountRoot, kids[0]);
    }
    if (!volume || !fs.existsSync(volume)) {
      throw new Error(`could not resolve DMG mount point from:\n${attachOut}`);
    }

    const dest = path.join(volume, scriptName);
    fs.copyFileSync(scriptSrc, dest);
    fs.chmodSync(dest, 0o755);
    try {
      sh("xattr", ["-cr", dest]);
    } catch {
      /* ignore */
    }
    console.log(`[gatekeeper-fix] on volume → ${dest}`);

    // Detach by device (more reliable than volume path).
    const disk = lines
      .map((l) => l.match(/^(\/dev\/disk\d+)/))
      .find(Boolean)?.[1];
    if (disk) {
      sh("hdiutil", ["detach", disk, "-force"]);
    } else {
      sh("hdiutil", ["detach", volume, "-force"]);
    }

    // Replace original DMG with compressed image.
    const outTmp = abs + ".new.dmg";
    if (fs.existsSync(outTmp)) fs.unlinkSync(outTmp);
    sh("hdiutil", ["convert", tmpRw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", outTmp]);
    fs.renameSync(outTmp, abs);
    console.log(`[gatekeeper-fix] wrote ${abs}`);
  } finally {
    try {
      if (fs.existsSync(tmpRw)) fs.unlinkSync(tmpRw);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(mountRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function main() {
  if (process.platform !== "darwin") {
    console.log("[gatekeeper-fix] skip (not macOS)");
    return;
  }
  if (!fs.existsSync(scriptSrc)) {
    throw new Error(`missing ${scriptSrc}`);
  }

  const apps = findApps();
  if (!apps.length) {
    console.warn("[gatekeeper-fix] no .app under target/release/bundle/macos — skip");
  } else {
    for (const app of apps) stageBesideApp(app);
  }

  const dmgs = findDmgs();
  if (!dmgs.length) {
    console.warn("[gatekeeper-fix] no .dmg under target/release/bundle/dmg — skip");
    return;
  }
  for (const dmg of dmgs) embedIntoDmg(dmg);
}

main();
