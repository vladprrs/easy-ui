#!/usr/bin/env node
/* global process */
// Синк share-зеркал харнеса (план agent-iteration-dx §4): канон driver.mjs живёт в
// .claude/skills/author/, зеркала в share/* отличаются от него ровно строкой импорта
// auth-модуля (побайтовое зеркалирование невозможно by design). Канон easyui-auth.mjs
// живёт в share/yp-figma-rebuild-skill/ — остальные копии проверяются на идентичность ему.
//
//   node scripts/sync-share-skills.mjs          # записать зеркала, пересобрать .tgz при расхождении
//   node scripts/sync-share-skills.mjs --check  # только проверка, exit 1 при расхождении (без записи)
//
// Идемпотентен: повторный прогон после успешного синка — no-op. Node ≥ 18, без зависимостей.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_DRIVER = ".claude/skills/author/driver.mjs";
// Клиентский кэш (план 2026-08-03 W7) — сосед драйвера: и в каноне, и в зеркале импорт один и
// тот же (`./cache.mjs`), поэтому файл зеркалится побайтово, без подмены строк.
const CANONICAL_CACHE = ".claude/skills/author/cache.mjs";
const CANONICAL_AUTH = "share/yp-figma-rebuild-skill/easyui-auth.mjs";
const AUTH_COPIES = ["scripts/easyui-auth.mjs", "share/easy-ui-authoring-skill/easyui-auth.mjs"];
const PACKAGES = ["easy-ui-authoring-skill", "yp-figma-rebuild-skill"];
const CANON_IMPORT = 'import { createEasyUiClient } from "../../../scripts/easyui-auth.mjs";';
const MIRROR_IMPORT = 'import { createEasyUiClient } from "./easyui-auth.mjs";';

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
if (args.some((arg) => arg !== "--check")) {
  console.error("usage: node scripts/sync-share-skills.mjs [--check]");
  process.exit(1);
}

const out = (line) => console.log(line);
let drift = 0;

/** Зеркалит `expected` в `path` (в --check только фиксирует расхождение). Печатает факт действия. */
function syncFile(path, expected, label) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === expected) {
    out(`in sync: ${path}`);
    return;
  }
  if (checkOnly) {
    drift += 1;
    out(`DRIFT: ${path} (${label})`);
    return;
  }
  writeFileSync(path, expected);
  out(`synced: ${path} (${label})`);
}

/** Карта относительный-путь → содержимое для всех файлов дерева (node_modules не входит). */
function walk(dir, prefix = "", files = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel, files);
    else if (entry.isFile()) files.set(rel, readFileSync(full));
  }
  return files;
}

/** Различия «архив vs каталог пакета»: архив хранит дерево с вершиной <pkg>/. */
function archiveDiffs(archivePath, packageDir, pkg) {
  if (!existsSync(archivePath)) return ["archive is missing"];
  const temp = mkdtempSync(join(tmpdir(), "sync-share-skills-"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", temp], { stdio: "pipe" });
    const archived = walk(temp);
    const local = walk(packageDir);
    const diffs = [];
    for (const [rel, content] of local) {
      const key = `${pkg}/${rel}`;
      if (!archived.has(key)) diffs.push(`missing in archive: ${rel}`);
      else if (!archived.get(key).equals(content)) diffs.push(`content differs: ${rel}`);
    }
    for (const key of archived.keys()) {
      if (!key.startsWith(`${pkg}/`)) diffs.push(`unexpected entry in archive: ${key}`);
      else if (!local.has(key.slice(pkg.length + 1))) diffs.push(`only in archive: ${key.slice(pkg.length + 1)}`);
    }
    return diffs;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// 1. driver.mjs: канон → оба зеркала, с заменой ровно одной строки импорта.
const canonical = readFileSync(resolve(root, CANONICAL_DRIVER), "utf8");
if (canonical.split(CANON_IMPORT).length - 1 !== 1) {
  console.error(`sync-share-skills: ${CANONICAL_DRIVER} must contain the auth import exactly once; the transform anchor drifted`);
  process.exit(1);
}
const mirrorDriver = canonical.replace(CANON_IMPORT, MIRROR_IMPORT);
for (const pkg of PACKAGES) syncFile(resolve(root, "share", pkg, "driver.mjs"), mirrorDriver, "import line rewritten to ./easyui-auth.mjs");

// 1b. cache.mjs: побайтовое зеркало канона в оба пакета.
const canonicalCache = readFileSync(resolve(root, CANONICAL_CACHE), "utf8");
for (const pkg of PACKAGES) syncFile(resolve(root, "share", pkg, "cache.mjs"), canonicalCache, `canonical is ${CANONICAL_CACHE}`);

// 2. easyui-auth.mjs: копии идентичны канону из yp-пакета.
const canonicalAuth = readFileSync(resolve(root, CANONICAL_AUTH), "utf8");
for (const copy of AUTH_COPIES) syncFile(resolve(root, copy), canonicalAuth, `canonical is ${CANONICAL_AUTH}`);

// 3. Архивы: пересборка только при фактическом расхождении содержимого.
for (const pkg of PACKAGES) {
  const archive = resolve(root, "share", `${pkg}.tgz`);
  const diffs = archiveDiffs(archive, resolve(root, "share", pkg), pkg);
  if (diffs.length === 0) {
    out(`in sync: share/${pkg}.tgz`);
    continue;
  }
  if (checkOnly) {
    drift += 1;
    for (const diff of diffs) out(`DRIFT: share/${pkg}.tgz: ${diff}`);
    continue;
  }
  execFileSync("tar", ["-czf", archive, "-C", resolve(root, "share"), "--exclude=node_modules", pkg]);
  out(`rebuilt: share/${pkg}.tgz`);
}

if (drift > 0) {
  console.error(`sync-share-skills: ${drift} artifact(s) out of sync; run node scripts/sync-share-skills.mjs`);
  process.exit(1);
}
out(checkOnly ? "check: everything in sync" : "done");
