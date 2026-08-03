/**
 * Renderer fingerprint 2.0 (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 E1, §5 R1).
 *
 * Зачем этот модуль существует. До него идентичность рендерера в продукте выражалась двумя
 * вещами, и обе врали:
 * - `rendererBuild` — имя entry-файла SPA (`server/screenshot/allowedUrls.ts`), то есть
 *   идентичность **бандла**, а не рендерера: про chromium, шрифты и системные библиотеки он не
 *   говорит ничего;
 * - серверный `captureEnvFingerprintOf(readinessPolicyHash)` (`server/acceptance/ids.ts`) —
 *   `sha256({platform, arch, readinessPolicyHash})`: апгрейд chromium его **не менял**, поэтому
 *   reuse `acceptance_case_results` по `case_fingerprint` переживал смену рендерера (дыра §1.3).
 *
 * Здесь объявляется то, чем кадр реально нарисован, и объявляется **до** съёмки — только такой
 * отпечаток годится ключом reuse-lookup'а (`case_fingerprint` считается до постановки джобы).
 *
 * Два факта, вокруг которых построен модуль (Stage 2, C-B1/T-M6):
 * 1. `chromium.launch({headless:true})` исполняет **`chrome-headless-shell`**, а
 *    `chromium.executablePath()` возвращает полный `chrome-linux64/chrome`, который не рендерит.
 *    Поэтому в отпечаток входит sha256 фактически запускаемого бинаря и его имя
 *    (`launchedExecutable`), а не «какой-то chromium».
 * 2. Значения этих полей известны только внутри образа, где браузер установлен, поэтому их
 *    считает build-слой (`scripts/renderer-manifest.mjs` → `/app/renderer-manifest.json`,
 *    путь в `EASYUI_RENDERER_MANIFEST`), а сервер их **читает**.
 *
 * Dev-фолбэк (T-m16). В рабочем дереве манифеста нет: модуль честно деградирует — дорогие поля
 * (`browserExecutableSha256`, `fontStackSha256`, `systemLibsHash`, `appFontsSha256`) становятся
 * `null`, дешёвые (os/arch/node/playwright/browsers.json) считаются на месте. Инвариант, который
 * важнее полноты: **внутри процесса отпечаток неизменен**. Поэтому снапшот замораживается при
 * первом же чтении и потом не мутирует — sha бинаря (≈1 с) в dev не считается вовсе, иначе
 * асинхронная догрузка меняла бы отпечаток на середине жизни процесса (C-m14).
 *
 * `provenance` (buildSha/imageRef/builtAt) в хеш **не входит** осознанно (N1): иначе каждый
 * коммит обнулял бы весь накопленный reuse.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { canonicalReadinessPolicy, DEFAULT_READINESS_POLICY, type ReadinessPolicy } from "../../src/capture/readinessPolicy";
import pin from "./rendererPin.json";

const require = createRequire(import.meta.url);

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * Версия схемы отпечатка рендерера. Растёт вместе со списком входов `rendererFingerprintOf`.
 * Схема 2 — первая, включающая фактически запускаемый бинарь (схема 1 — снятый
 * `captureEnvFingerprintOf`, где не было ни браузера, ни шрифтов).
 */
export const RENDERER_SCHEMA = 2;

/**
 * Ручная версия рендерера репозитория. Поднимается **вместе** с `rendererPin.json` в PR,
 * который меняет chromium/базовый образ; `npm run verify:renderer` не даёт им разъехаться.
 */
export const RENDERER_VERSION: string = pin.rendererVersion;

/** Происхождение сборки — рядом с отпечатком, но вне его (N1). */
export interface RendererProvenance {
  buildSha: string | null;
  imageRef: string | null;
  builtAt: string | null;
  bunVersion: string | null;
}

/** Объявленный рендерер: то, чем этот процесс собирается рисовать кадры. */
export interface RendererDeclaration {
  rendererSchema: number;
  rendererVersion: string;
  os: string;
  arch: string;
  nodeVersion: string | null;
  playwrightVersion: string | null;
  browserName: string;
  browserVersion: string | null;
  browserRevision: string | null;
  launchedExecutable: string | null;
  browserExecutableSha256: string | null;
  fontStackSha256: string | null;
  appFontsSha256: string | null;
  systemLibsHash: string | null;
  launchDeterminismArgsHash: string;
  contextOptionsHash: string | null;
  colorProfile: "srgb";
  /** `manifest` — прочитан build-time манифест образа; `fallback` — dev-деградация. */
  source: "manifest" | "fallback";
  /** Вне хеша: происхождение сборки. `null` в dev-фолбэке. */
  provenance: RendererProvenance | null;
}

/**
 * Детерминизм-флаги запуска (§2.1 P1). В R1 здесь только явные дубли того, что playwright уже
 * передаёт сам: смысл дубля — зафиксировать флаг в **нашем** хеше, чтобы отпечаток перестал
 * зависеть от внутренностей `chromiumSwitches()` конкретной версии playwright. Остальные флаги
 * (`--disable-skia-runtime-opts`, `--font-render-hinting=none`, …) добавляет R2a — их появление
 * меняет `launchDeterminismArgsHash` и, значит, отпечаток: это и есть заявленная точка
 * инвалидации reuse №2 (§4).
 *
 * Список отсортирован и возвращается копией: он хешируется дословно.
 */
export function buildDeterminismArgs(): string[] {
  return ["--force-color-profile=srgb", "--hide-scrollbars"];
}

const determinismArgsHash = (): string => sha256(canonicalStringify(buildDeterminismArgs()));

/**
 * Отпечаток рендерера — чистая функция объявления и хэша readiness-политики.
 *
 * Политика входит сюда, а не рядом, ровно по той же причине, что и в снятом
 * `captureEnvFingerprintOf`: кадр, снятый по другой политике ожидания, — другой кадр.
 * `source`/`provenance` в хеш не входят (N1: digest/коммит не меняют рендерер).
 */
export function rendererFingerprintOf(declaration: RendererDeclaration, readinessPolicyHash: string): string {
  return sha256(canonicalStringify({
    rendererSchema: declaration.rendererSchema,
    rendererVersion: declaration.rendererVersion,
    os: declaration.os,
    arch: declaration.arch,
    nodeVersion: declaration.nodeVersion,
    playwrightVersion: declaration.playwrightVersion,
    browserName: declaration.browserName,
    browserVersion: declaration.browserVersion,
    browserRevision: declaration.browserRevision,
    launchedExecutable: declaration.launchedExecutable,
    browserExecutableSha256: declaration.browserExecutableSha256,
    fontStackSha256: declaration.fontStackSha256,
    appFontsSha256: declaration.appFontsSha256,
    systemLibsHash: declaration.systemLibsHash,
    launchDeterminismArgsHash: declaration.launchDeterminismArgsHash,
    contextOptionsHash: declaration.contextOptionsHash,
    colorProfile: declaration.colorProfile,
    readinessPolicyHash,
  }));
}

const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Читает build-time манифест; любая ошибка (нет файла, битый JSON) — `null`, без броска. */
export function readRendererManifest(file: string | undefined = process.env.EASYUI_RENDERER_MANIFEST): Record<string, unknown> | null {
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Объявление из прочитанного манифеста. Отсутствующие поля деградируют в `null`, а не врут. */
export function declarationFromManifest(manifest: Record<string, unknown>): RendererDeclaration {
  const provenanceRaw = manifest.provenance as Record<string, unknown> | undefined;
  return {
    rendererSchema: RENDERER_SCHEMA,
    rendererVersion: asString(manifest.rendererVersion) ?? RENDERER_VERSION,
    os: asString(manifest.os) ?? process.platform,
    arch: asString(manifest.arch) ?? process.arch,
    nodeVersion: asString(manifest.nodeVersion),
    playwrightVersion: asString(manifest.playwrightVersion),
    browserName: asString(manifest.browserName) ?? "chromium",
    browserVersion: asString(manifest.browserVersion),
    browserRevision: asString(manifest.browserRevision),
    launchedExecutable: asString(manifest.launchedExecutable),
    browserExecutableSha256: asString(manifest.browserExecutableSha256),
    fontStackSha256: asString(manifest.fontStackSha256),
    appFontsSha256: asString(manifest.appFontsSha256),
    systemLibsHash: asString(manifest.systemLibsHash),
    launchDeterminismArgsHash: determinismArgsHash(),
    contextOptionsHash: asString(manifest.contextOptionsHash),
    colorProfile: "srgb",
    source: "manifest",
    provenance: provenanceRaw === undefined || provenanceRaw === null ? null : {
      buildSha: asString(provenanceRaw.buildSha),
      imageRef: asString(provenanceRaw.imageRef),
      builtAt: asString(provenanceRaw.builtAt),
      bunVersion: asString(provenanceRaw.bunVersion),
    },
  };
}

/** Дешёвые синхронные факты рабочего дерева: версия playwright и объявленный chromium. */
function localPlaywrightFacts(): { playwrightVersion: string | null; browserVersion: string | null; browserRevision: string | null } {
  try {
    const pkg = require("playwright/package.json") as { version?: string };
    const corePkg = require.resolve("playwright-core/package.json");
    const browsers = JSON.parse(readFileSync(corePkg.replace(/package\.json$/, "browsers.json"), "utf8")) as {
      browsers?: { name?: string; revision?: string; browserVersion?: string }[];
    };
    const shell = (browsers.browsers ?? []).find((item) => item.name === "chromium-headless-shell")
      ?? (browsers.browsers ?? []).find((item) => item.name === "chromium");
    return {
      playwrightVersion: asString(pkg.version),
      browserVersion: asString(shell?.browserVersion),
      browserRevision: asString(shell?.revision),
    };
  } catch {
    return { playwrightVersion: null, browserVersion: null, browserRevision: null };
  }
}

/**
 * Dev-объявление: всё, что известно **синхронно и дёшево**. sha бинаря/шрифтов/системных
 * библиотек здесь честно `null` — см. заголовок модуля: стабильность отпечатка внутри процесса
 * дороже его полноты в рабочем дереве.
 */
export function fallbackDeclaration(): RendererDeclaration {
  const local = localPlaywrightFacts();
  return {
    rendererSchema: RENDERER_SCHEMA,
    rendererVersion: RENDERER_VERSION,
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node ?? null,
    playwrightVersion: local.playwrightVersion,
    browserName: "chromium",
    browserVersion: local.browserVersion,
    browserRevision: local.browserRevision,
    launchedExecutable: "chrome-headless-shell",
    browserExecutableSha256: null,
    fontStackSha256: null,
    appFontsSha256: null,
    systemLibsHash: null,
    launchDeterminismArgsHash: determinismArgsHash(),
    contextOptionsHash: null,
    colorProfile: "srgb",
    source: "fallback",
    provenance: null,
  };
}

let frozen: RendererDeclaration | null = null;

/**
 * Объявление рендерера этого процесса. Первое обращение замораживает снапшот — дальше он
 * неизменен, чем бы ни занимался `initRenderer()`.
 */
export function rendererDeclaration(): RendererDeclaration {
  if (frozen === null) {
    const manifest = readRendererManifest();
    frozen = manifest === null ? fallbackDeclaration() : declarationFromManifest(manifest);
  }
  return frozen;
}

/** Отпечаток рендерера этого процесса под конкретную readiness-политику. */
export function rendererFingerprint(readinessPolicyHash: string): string {
  return rendererFingerprintOf(rendererDeclaration(), readinessPolicyHash);
}

/**
 * Хэш readiness-политики — тот же алгоритм и тот же вход, что у `readinessPolicyHashOf`
 * (`server/acceptance/ids.ts`) и у клиентского `readinessPolicyHash`. Продублирован здесь, а не
 * импортирован, чтобы `ids.ts → renderer.ts` осталась единственной стрелкой между модулями.
 */
export function policyHashOf(policy: ReadinessPolicy): string {
  return sha256(canonicalReadinessPolicy(policy));
}

/** Хэш дефолтной readiness-политики: тот же алгоритм, что у `readinessPolicyHashOf` (ids.ts). */
export const DEFAULT_RENDERER_POLICY_HASH: string = policyHashOf(DEFAULT_READINESS_POLICY);

/**
 * Публичная (discovery) проекция рендерера: `GET /api/capabilities` и `GET /api/health`.
 * `fingerprint` — под **дефолтной** readiness-политикой: именно по ней снимают интерактивные
 * капчуры, а профили приёмки публикуют свой хэш политики в метриках гейта `readiness`.
 */
export function rendererReport(): RendererDeclaration & { fingerprint: string; policyHash: string } {
  const declaration = rendererDeclaration();
  return {
    ...declaration,
    policyHash: DEFAULT_RENDERER_POLICY_HASH,
    fingerprint: rendererFingerprintOf(declaration, DEFAULT_RENDERER_POLICY_HASH),
  };
}

/**
 * Строгая сверка манифеста (E2, T-M7). `EASYUI_RENDERER_STRICT_MANIFEST=0` — аварийный
 * kill-switch: расхождение деградирует до warning, капчуры продолжают идти.
 */
export function strictManifestEnabled(): boolean {
  return process.env.EASYUI_RENDERER_STRICT_MANIFEST !== "0";
}

/** `149.0.7827.55` → `149.0.7827`; всё, что не похоже на версию chromium, — `null`. */
export function majorMinorBuild(version: string | null | undefined): string | null {
  if (typeof version !== "string") return null;
  const match = /(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Сверка наблюдённой версии браузера с объявленной — по `major.minor.build` (T-M7: patch-часть
 * плавает между сборками одного chromium и не влияет на растр).
 *
 * Сравнение производится **только** когда обе стороны разбираются в версию chromium: тестовые
 * стенды присылают синтетические строки (`"test/1"`), и превращать их в отказ капчура — способ
 * уронить всё, кроме прода.
 */
export function compareBrowserVersion(declared: string | null, observed: string | null): "match" | "mismatch" | "unknown" {
  const a = majorMinorBuild(declared), b = majorMinorBuild(observed);
  if (a === null || b === null) return "unknown";
  return a === b ? "match" : "mismatch";
}

export interface RendererSelfCheck {
  declaration: RendererDeclaration;
  fingerprint: string;
  /** Расхождения/деградации, найденные на старте: пустой массив — всё сошлось. */
  warnings: string[];
}

/**
 * Self-check на старте процесса (E2): расхождение образа и манифеста обязано быть видно деплою,
 * а не первому капчуру. Асинхронна намеренно — точка расширения для дорогих проб; сегодня она
 * ничего не мутирует: снапшот заморожен первым чтением.
 */
export async function initRenderer(): Promise<RendererSelfCheck> {
  const declaration = rendererDeclaration();
  const warnings: string[] = [];
  if (declaration.source === "fallback") {
    warnings.push("renderer manifest is absent (EASYUI_RENDERER_MANIFEST unset or unreadable): renderer fingerprint runs in degraded dev mode");
  } else {
    if (declaration.browserExecutableSha256 === null) warnings.push("renderer manifest carries no browserExecutableSha256");
    if (declaration.rendererVersion !== RENDERER_VERSION) {
      warnings.push(`renderer manifest declares rendererVersion=${declaration.rendererVersion}, repository pin is ${RENDERER_VERSION}`);
    }
    const pinned = compareBrowserVersion(pin.chromiumHeadlessShell.browserVersion, declaration.browserVersion);
    if (pinned === "mismatch") {
      warnings.push(`renderer manifest browserVersion=${declaration.browserVersion} differs from rendererPin.json (${pin.chromiumHeadlessShell.browserVersion})`);
    }
  }
  // `EASYUI_RENDERER_EPOCH` осмыслен только вместе с новыми пикселями (N11/V-N5): заданная без
  // `EASYUI_RENDERER_FLAGS` эпоха — почти наверняка забытая переменная, и она обязана быть видна.
  if (process.env.EASYUI_RENDERER_EPOCH && process.env.EASYUI_RENDERER_FLAGS !== "1") {
    warnings.push("EASYUI_RENDERER_EPOCH is set without EASYUI_RENDERER_FLAGS=1 and is therefore ignored");
  }
  return { declaration, fingerprint: rendererFingerprintOf(declaration, DEFAULT_RENDERER_POLICY_HASH), warnings };
}

/** Тестовый шов: сбрасывает замороженный снапшот. Только для тестов модуля. */
export function __resetRendererForTest(): void {
  frozen = null;
}
