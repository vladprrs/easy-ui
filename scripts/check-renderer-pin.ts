/**
 * `npm run verify:renderer` — drift-чек рендерера (план 2026-08-03-renderer-contract-2 §2.2 N2).
 *
 * Апгрейд chromium обязан быть **явным PR'ом**, а не побочным эффектом `npm install`: отпечаток
 * рендерера (`server/capture/renderer.ts`) входит в `case_fingerprint` и в будущий cross-renderer
 * guard, поэтому молчаливая смена браузера обесценивает и накопленный reuse, и эталоны.
 *
 * Проверяется ровно то, что может разъехаться само:
 * 1. точность пинов `playwright` и `@playwright/test` (каретка у второго — риск второго
 *    `playwright-core` в дереве, T-M7);
 * 2. единственность `playwright-core` в lockfile (два ядра = два разных chromium);
 * 3. совпадение фактического `browsers.json` с `server/capture/rendererPin.json` — по revision и
 *    по версии браузера, отдельно для `chromium` и для **фактически запускаемого**
 *    `chromium-headless-shell` (C-B1: рендерит именно он);
 * 4. согласованность `rendererPin.json` с `RENDERER_VERSION` модуля и с пином базового образа в
 *    `Dockerfile` — ручной bump обязан быть согласованным, иначе он бессмыслен.
 *
 * Запускается под node (tsx), без bun-специфики: он часть `npm run verify`.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");

interface RendererPin {
  rendererVersion: string;
  playwright: string;
  playwrightTest: string;
  chromium: { revision: string; browserVersion: string };
  chromiumHeadlessShell: { revision: string; browserVersion: string };
  baseImage: string;
}

const EXACT = /^\d+\.\d+\.\d+$/;

function browsersJson(): { browsers?: { name?: string; revision?: string; browserVersion?: string }[] } {
  const pkg = require.resolve("playwright-core/package.json");
  return JSON.parse(readFileSync(path.join(path.dirname(pkg), "browsers.json"), "utf8")) as ReturnType<typeof browsersJson>;
}

function main(): void {
  const problems: string[] = [];
  const pin = JSON.parse(read("server/capture/rendererPin.json")) as RendererPin;
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

  const declaredPlaywright = pkg.dependencies.playwright;
  const declaredTest = pkg.devDependencies["@playwright/test"];
  if (!EXACT.test(declaredPlaywright ?? "")) problems.push(`package.json dependencies.playwright must be an exact version, got "${declaredPlaywright}"`);
  if (!EXACT.test(declaredTest ?? "")) problems.push(`package.json devDependencies["@playwright/test"] must be an exact version (a caret risks a second playwright-core), got "${declaredTest}"`);
  if (declaredPlaywright !== pin.playwright) problems.push(`playwright ${declaredPlaywright} ≠ rendererPin.json playwright ${pin.playwright}`);
  if (declaredTest !== pin.playwrightTest) problems.push(`@playwright/test ${declaredTest} ≠ rendererPin.json playwrightTest ${pin.playwrightTest}`);

  const installed = (require("playwright/package.json") as { version: string }).version;
  if (installed !== pin.playwright) problems.push(`installed playwright ${installed} ≠ rendererPin.json playwright ${pin.playwright} (run npm install)`);

  // Единственность ядра: `node_modules/**/playwright-core` в lockfile должен быть ровно один.
  const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
  const cores = Object.keys(lock.packages).filter((key) => key.endsWith("node_modules/playwright-core"));
  if (cores.length !== 1) problems.push(`lockfile carries ${cores.length} playwright-core installs (${cores.join(", ")}); exactly one is required`);

  const browsers = browsersJson().browsers ?? [];
  const expect = (name: string, pinned: { revision: string; browserVersion: string }): void => {
    const entry = browsers.find((item) => item.name === name);
    if (!entry) { problems.push(`browsers.json has no "${name}" entry`); return; }
    if (entry.revision !== pinned.revision) problems.push(`${name} revision ${entry.revision} ≠ pinned ${pinned.revision}`);
    if (entry.browserVersion !== pinned.browserVersion) problems.push(`${name} browserVersion ${entry.browserVersion} ≠ pinned ${pinned.browserVersion}`);
  };
  expect("chromium", pin.chromium);
  expect("chromium-headless-shell", pin.chromiumHeadlessShell);

  const rendererSource = read("server/capture/renderer.ts");
  if (!rendererSource.includes('import pin from "./rendererPin.json"')) {
    problems.push("server/capture/renderer.ts no longer reads RENDERER_VERSION from rendererPin.json");
  }
  // scripts/renderer-manifest.mjs хардкодит собственный RENDERER_VERSION (в build-слое образа
  // rendererPin.json недоступен) — версия в манифесте обязана совпадать с пином.
  const manifestScript = read("scripts/renderer-manifest.mjs");
  if (!manifestScript.includes(`RENDERER_VERSION = "${pin.rendererVersion}"`)) {
    problems.push(`scripts/renderer-manifest.mjs RENDERER_VERSION does not match rendererPin.json rendererVersion (${pin.rendererVersion})`);
  }
  const dockerfile = read("Dockerfile");
  if (!dockerfile.includes(`FROM ${pin.baseImage}`)) {
    problems.push(`Dockerfile base image does not match rendererPin.json baseImage (${pin.baseImage})`);
  }

  if (problems.length > 0) {
    console.error("renderer pin drift detected:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nA chromium/base-image upgrade must be an explicit PR: update server/capture/rendererPin.json (and RENDERER_VERSION when the raster can change).");
    process.exit(1);
  }
  console.log(`renderer pin ok: ${pin.rendererVersion}, playwright ${pin.playwright}, chromium-headless-shell ${pin.chromiumHeadlessShell.browserVersion} (r${pin.chromiumHeadlessShell.revision})`);
}

main();
