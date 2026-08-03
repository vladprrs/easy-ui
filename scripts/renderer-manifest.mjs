// Renderer manifest generator (plan 2026-08-03-renderer-contract-2 §5 R0, §2.2 N1).
// Prints a JSON document describing the renderer of THIS image/machine: playwright,
// the actually launched browser binary (chrome-headless-shell, not chrome), the font
// stack and the system libraries that affect rasterization. Runs under node with only
// builtins + the local playwright install. Never throws: any missing resource
// degrades to null and the process still exits 0.
/* global process */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RENDERER_VERSION = "r2";
const MANIFEST_VERSION = 1;

/** sha256 hex of a string. */
function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 hex of a file, null when unreadable. */
function sha256File(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function safe(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** playwright package version (the installed one, not the declared range). */
function playwrightVersion() {
  return safe(() => require("playwright/package.json").version);
}

/**
 * browsers.json of playwright-core. The subpath is not exported
 * (require("playwright-core/browsers.json") => ERR_PACKAGE_PATH_NOT_EXPORTED),
 * so resolve package.json and read the sibling file.
 */
function browsersJson() {
  return safe(() => {
    const pkg = require.resolve("playwright-core/package.json");
    const file = path.join(path.dirname(pkg), "browsers.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  });
}

function chromiumDescriptor(browsers) {
  const list = Array.isArray(browsers?.browsers) ? browsers.browsers : [];
  return list.find((b) => b?.name === "chromium") ?? null;
}

/** Registry lookup of an executable path; "./lib/coreBundle" is an exported subpath. */
function registryExecutablePath(name) {
  return safe(() => {
    const mod = require("playwright-core/lib/coreBundle");
    const registry = mod?.registry?.registry ?? mod?.registry;
    const executable = registry?.findExecutable?.(name);
    const file = executable?.executablePath?.();
    return typeof file === "string" && file ? file : null;
  });
}

/** Fallback location of the headless-shell binary when the registry API is unavailable. */
function headlessShellByGlob(revision) {
  return safe(() => {
    const browsersDir =
      process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
    const entries = fs.readdirSync(browsersDir, { withFileTypes: true });
    const rank = (name) => (revision && name === `chromium_headless_shell-${revision}` ? 0 : 1);
    const dirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("chromium_headless_shell-"))
      .map((e) => e.name)
      // exact revision first, then newest-looking name
      .sort((a, b) => rank(a) - rank(b) || (a < b ? 1 : a > b ? -1 : 0))
      .map((name) => path.join(browsersDir, name));
    const names = new Set(["chrome-headless-shell", "headless_shell"]);
    const walk = (dir, depth) => {
      if (depth > 3) return null;
      let list;
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const entry of list) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && names.has(entry.name)) return full;
        if (entry.isDirectory()) {
          const found = walk(full, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    for (const dir of dirs) {
      const found = walk(dir, 0);
      if (found) return found;
    }
    return null;
  });
}

function existingFile(file) {
  if (!file) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Authoritative browser version: launch probe, then `--version`, then null. */
async function probeBrowserVersion(shellPath) {
  const launched = await (async () => {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        return browser.version();
      } finally {
        await browser.close().catch(() => {});
      }
    } catch {
      return null;
    }
  })();
  if (launched) return launched;
  if (!shellPath) return null;
  return safe(() => {
    const out = execFileSync(shellPath, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
    return match ? match[1] : null;
  });
}

/** Recursive file list of a directory as [relpath, absolute, size]. */
function walkFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        let size = null;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        out.push({ rel: relPath, full, size });
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * Font stack of the image: every file under /usr/share/fonts and /etc/fonts as
 * "<prefix>/<relpath>|<size>", sorted. fc-list does not exist in node:24-slim,
 * so the traversal is our own. Both directories missing => null.
 */
function fontStackSha256() {
  const roots = [
    ["usr-share-fonts", "/usr/share/fonts"],
    ["etc-fonts", "/etc/fonts"],
  ];
  const lines = [];
  let seenAny = false;
  for (const [prefix, root] of roots) {
    let exists = false;
    try {
      exists = fs.statSync(root).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    seenAny = true;
    for (const file of walkFiles(root)) lines.push(`${prefix}/${file.rel}|${file.size}`);
  }
  if (!seenAny) return null;
  lines.sort();
  return sha256Text(lines.join("\n"));
}

/** Versions of the packages that shape glyph rasterization; no dpkg-query => null. */
function systemLibsHash() {
  const packages = ["libfontconfig1", "libfreetype6", "fonts-liberation"];
  const lines = [];
  let queried = false;
  for (const pkg of packages) {
    const line = safe(() => {
      const out = execFileSync("dpkg-query", ["-W", "-f", "${Package} ${Version}\n", pkg], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim();
    });
    if (line === null) continue;
    queried = true;
    if (line) lines.push(line);
  }
  if (!queried) return null;
  lines.sort();
  return sha256Text(`${lines.join("\n")}\n`);
}

/** App-shipped webfonts: "<relpath>|<sha256>" over dist/fonts; missing dir => null. */
function appFontsSha256() {
  const root = path.join(repoRoot, "dist", "fonts");
  try {
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const lines = [];
  for (const file of walkFiles(root)) {
    const hash = sha256File(file.full);
    if (hash) lines.push(`${file.rel}|${hash}`);
  }
  lines.sort();
  return sha256Text(lines.join("\n"));
}

async function main() {
  const browsers = browsersJson();
  const chromium = chromiumDescriptor(browsers);
  const shellPath =
    existingFile(registryExecutablePath("chromium-headless-shell")) ??
    existingFile(headlessShellByGlob(chromium?.revision ?? null));
  const chromePath =
    existingFile(registryExecutablePath("chromium")) ??
    existingFile(safe(() => require("playwright").chromium.executablePath()));

  const buildSha = process.env.EASYUI_BUILD_SHA || null;

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    rendererVersion: RENDERER_VERSION,
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    playwrightVersion: playwrightVersion(),
    browserName: "chromium",
    browserVersion: await probeBrowserVersion(shellPath),
    browserVersionDeclared: chromium?.browserVersion ?? null,
    browserRevision: chromium?.revision ?? null,
    launchedExecutable: "chrome-headless-shell",
    browserExecutableSha256: shellPath ? sha256File(shellPath) : null,
    chromeExecutableSha256: chromePath ? sha256File(chromePath) : null,
    fontStackSha256: fontStackSha256(),
    systemLibsHash: systemLibsHash(),
    appFontsSha256: appFontsSha256(),
    contextOptionsHash: null,
    provenance: {
      buildSha,
      imageRef: buildSha ? `ghcr.io/vladprrs/easy-ui:${buildSha}` : null,
      builtAt: new Date().toISOString(),
      bunVersion: null,
    },
  };

  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().then(
  () => {
    process.exitCode = 0;
  },
  () => {
    process.exitCode = 0;
  },
);
