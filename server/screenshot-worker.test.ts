import { createRequire } from "node:module";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BASE_DETERMINISM_ARGS,
  buildDeterminismArgs,
  buildLaunchArgs,
  canonicalStringify,
  CAPTURE_CONTEXT_OPTIONS,
  matchAllowed,
  readyToExpected,
  STRICT_DETERMINISM_ARGS,
  WORKER_FAILURE_CODES,
} from "../scripts/screenshot-worker.mjs";
import { CAPTURE_FAILURE_CODES } from "../src/capture/failureCodes";
import { collectGeometry, unionRects } from "../src/capture/geometry.mjs";
import {
  buildDeterminismArgs as serverDeterminismArgs,
  CONTEXT_OPTIONS_HASH,
  rendererDeclaration,
  rendererFlagsEnabled,
  __resetRendererForTest,
} from "./capture/renderer";

const require = createRequire(import.meta.url);

/** Путь фактически запускаемого бинаря: playwright-реестр, иначе обход кэша браузеров. */
function headlessShellPath(): string | null {
  const viaRegistry = ((): string | null => {
    try {
      const mod = require("playwright-core/lib/coreBundle") as { registry?: { registry?: unknown } };
      const registry = (mod.registry as { registry?: unknown } | undefined)?.registry ?? mod.registry;
      const executable = (registry as { findExecutable?: (name: string) => { executablePath?: () => string } } | undefined)
        ?.findExecutable?.("chromium-headless-shell");
      const file = executable?.executablePath?.();
      return typeof file === "string" && file.length > 0 ? file : null;
    } catch {
      return null;
    }
  })();
  if (viaRegistry !== null && isFile(viaRegistry)) return viaRegistry;
  return findBrowserBinary("chromium_headless_shell-", new Set(["chrome-headless-shell", "headless_shell"]));
}

/** Полный `chrome` — тот, который playwright headless-режимом НЕ запускает (C-B1). */
function fullChromePath(): string | null {
  return findBrowserBinary("chromium-", new Set(["chrome"]));
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function findBrowserBinary(dirPrefix: string, names: Set<string>): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3) return null;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && names.has(entry.name)) return full;
      if (entry.isDirectory()) { const found = walk(full, depth + 1); if (found !== null) return found; }
    }
    return null;
  };
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of dirs.sort((a, b) => (a.name < b.name ? 1 : -1))) {
    if (!entry.isDirectory() || !entry.name.startsWith(dirPrefix)) continue;
    const found = walk(join(root, entry.name), 0);
    if (found !== null) return found;
  }
  return null;
}

/** Есть ли строка в бинаре: потоковое чтение чанками с перекрытием (файл ~150 МБ). */
function binaryContains(file: string, needle: string): boolean {
  const pattern = Buffer.from(needle, "utf8");
  const size = 4 << 20;
  const buffer = Buffer.alloc(size);
  const fd = openSync(file, "r");
  try {
    let tail = Buffer.alloc(0);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, size, position);
      if (read === 0) return false;
      position += read;
      // Склейка с хвостом предыдущего чанка: иначе совпадение на границе было бы потеряно.
      const window = Buffer.concat([tail, buffer.subarray(0, read)]);
      if (window.includes(pattern)) return true;
      tail = Buffer.from(window.subarray(Math.max(0, window.length - (pattern.length - 1))));
    }
  } finally {
    closeSync(fd);
  }
}

const flagBefore = process.env.EASYUI_RENDERER_FLAGS;

afterEach(() => {
  if (flagBefore === undefined) delete process.env.EASYUI_RENDERER_FLAGS;
  else process.env.EASYUI_RENDERER_FLAGS = flagBefore;
  __resetRendererForTest();
});

describe("screenshot worker helpers", () => {
  test("egress launch args are exact (port-scoped proxy-bypass + deny-proxy)", () => {
    expect(buildLaunchArgs(41111, "4173")).toEqual([
      "--proxy-server=http://127.0.0.1:41111",
      "--proxy-bypass-list=<-loopback>;127.0.0.1:4173",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--disable-quic",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy",
    ]);
  });

  // R2a (план 2026-08-03 renderer-contract-2 §5): список хешируется дословно в
  // `launchDeterminismArgsHash`, поэтому он проверяется дословно — любая правка обязана быть
  // осознанной сменой отпечатка рендерера, а не побочным эффектом.
  test("determinism args are exact: base duplicates playwright's own switches", () => {
    expect(buildDeterminismArgs(false)).toEqual([
      "--force-color-profile=srgb",
      "--hide-scrollbars",
    ]);
  });

  test("determinism args are exact: EASYUI_RENDERER_FLAGS=1 adds the rasterization switches", () => {
    expect(buildDeterminismArgs(true)).toEqual([
      "--disable-font-subpixel-positioning",
      "--disable-lcd-text",
      "--disable-partial-raster",
      "--disable-skia-runtime-opts",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      "--hide-scrollbars",
    ]);
  });

  test("determinism args are a sorted copy: mutating the result cannot poison the hash", () => {
    const args = buildDeterminismArgs(true);
    args.push("--evil");
    expect(buildDeterminismArgs(true)).not.toContain("--evil");
    expect(BASE_DETERMINISM_ARGS).toEqual([...BASE_DETERMINISM_ARGS].sort());
    expect(STRICT_DETERMINISM_ARGS).toEqual([...STRICT_DETERMINISM_ARGS].sort());
  });

  // T-m17: воркер не читает `EASYUI_RENDERER_FLAGS` вовсе — решение принимает сервер и шлёт
  // args в payload. Иначе объявленный отпечаток и фактический запуск разъезжались бы молча.
  test("the worker never reads the renderer flag from the environment", () => {
    const source = readFileSync(new URL("../scripts/screenshot-worker.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("process.env");
    expect(source).toContain("job.determinismArgs");
  });

  test("server-side flag selection is the same list the worker would build", () => {
    __resetRendererForTest();
    expect(serverDeterminismArgs()).toEqual(buildDeterminismArgs(rendererFlagsEnabled()));
    process.env.EASYUI_RENDERER_FLAGS = "1";
    __resetRendererForTest();
    expect(serverDeterminismArgs()).toEqual(buildDeterminismArgs(true));
    // Флаг обязан быть входом отпечатка: иначе кадры «до» и «после» переиспользовались бы.
    const withFlags = rendererDeclaration().launchDeterminismArgsHash;
    delete process.env.EASYUI_RENDERER_FLAGS;
    __resetRendererForTest();
    expect(rendererDeclaration().launchDeterminismArgsHash).not.toBe(withFlags);
  });

  test("context options are hashed from the worker constant, not from the image manifest", () => {
    expect(CAPTURE_CONTEXT_OPTIONS).toEqual({ locale: "ru-RU", timezoneId: "Europe/Moscow", reducedMotion: "reduce" });
    expect(CONTEXT_OPTIONS_HASH).toMatch(/^[0-9a-f]{64}$/);
    __resetRendererForTest();
    expect(rendererDeclaration().contextOptionsHash).toBe(CONTEXT_OPTIONS_HASH);
  });

  // C-m11: `--font-render-hinting` и `--deterministic-mode` существуют ТОЛЬКО в
  // chrome-headless-shell — полный `chrome` этих switch'ей не знает и молча их игнорирует
  // (проверено: неизвестный switch не даёт ни ошибки, ни диагностики). Поэтому «принимает
  // флаги» проверяется статически — наличием имени switch'а в фактически запускаемом бинаре.
  // Смена channel/headless на полный chrome обязана красить этот тест, а не тихо ронять
  // детерминизм растра.
  test("the actually launched binary knows every determinism switch", () => {
    const shell = headlessShellPath();
    expect(shell).not.toBeNull();
    for (const arg of buildDeterminismArgs(true)) {
      const name = arg.split("=")[0]!.replace(/^--/, "");
      expect({ switch: name, present: binaryContains(shell!, name) }).toEqual({ switch: name, present: true });
    }
    // Матчер не вакуумный: несуществующий switch в бинаре отсутствует.
    expect(binaryContains(shell!, "easyui-not-a-chromium-switch")).toBe(false);
    // И тот же набор в полном `chrome` НЕ полон — это и есть защита от смены channel.
    const full = fullChromePath();
    if (full !== null) expect(binaryContains(full, "font-render-hinting")).toBe(false);
  });

  test("allowlist + canonical hashing mirror the server implementation", () => {
    expect(matchAllowed("/assets/x.js", ["/assets/"])).toBe(true);
    expect(matchAllowed("/evil", ["/assets/"])).toBe(false);
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  test("prototype readiness comparison includes the immutable instance id",()=>{
    expect(readyToExpected({kind:"prototype",revision:2,prototypeInstanceId:"instance-2",componentManifestHash:"m",builtinCatalogHash:"b",designSystem:"shadcn",dsMetaVersion:null,rendererBuild:null})).toEqual({kind:"prototype",rev:2,prototypeInstanceId:"instance-2",componentManifestHash:"m",builtinCatalogHash:"b",designSystem:"shadcn",dsMetaVersion:null,rendererBuild:null});
  });

  // Мульти-поверхностный handshake (multi-surface D14): поверхность обязана назвать резолвнутую
  // ДС снимаемого экрана; отсутствие поля в ready деградирует до `null` и не совпадёт с expected.
  test("prototype readiness carries the resolved design system of the captured screen",()=>{
    expect(readyToExpected({kind:"prototype",revision:1,prototypeInstanceId:"i",componentManifestHash:"m",builtinCatalogHash:"b",designSystem:"yandex-pay",dsMetaVersion:4,rendererBuild:null}))
      .toMatchObject({designSystem:"yandex-pay",dsMetaVersion:4});
    expect(readyToExpected({kind:"prototype",revision:1,prototypeInstanceId:"i",componentManifestHash:"m",builtinCatalogHash:"b",dsMetaVersion:null,rendererBuild:null}))
      .toMatchObject({designSystem:null});
  });

  test("component-draft readiness comparison carries the content-addressed identity",()=>{
    expect(readyToExpected({kind:"component-draft",componentId:"w",rev:3,sourceHash:"s".repeat(64),bundleHash:"b",propsHash:"p",dsMetaVersion:2,rendererBuild:null}))
      .toEqual({kind:"component-draft",componentId:"w",rev:3,sourceHash:"s".repeat(64),bundleHash:"b",propsHash:"p",dsMetaVersion:2,rendererBuild:null});
  });

  /**
   * R3: воркер — `.mjs` под node и TS-словарь импортировать не может, поэтому коды в нём
   * продублированы строками. Здесь дубль сверяется с единственным источником правды: разъехаться
   * молча они не могут.
   */
  test("worker failure codes belong to the product-wide dictionary", () => {
    for (const code of Object.values(WORKER_FAILURE_CODES)) {
      expect(CAPTURE_FAILURE_CODES as readonly string[]).toContain(code);
    }
    expect(Object.values(WORKER_FAILURE_CODES).sort()).toEqual(["navigation_failed", "runtime_error", "surface_missing"]);
  });

  /**
   * Отсутствие `#eui-capture-surface` раньше молча деградировало в `page.screenshot()` — кадр
   * «чего-то» уезжал в эталоны и давал необъяснимый визуальный провал (§5 R3). Проверяется по
   * исходнику: поднимать chromium ради отрицательного случая в unit-тесте незачем, а фактическое
   * поведение закрывает `e2e/preview/capture-failure-codes.spec.ts`.
   */
  test("a missing capture surface is refused, not silently degraded to a full-page screenshot", () => {
    const source = readFileSync(new URL("../scripts/screenshot-worker.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("await page.screenshot(");
    expect(source.match(/WORKER_FAILURE_CODES\.surfaceMissing/g)?.length).toBe(2);
    // Навигация и handshake — разные коды, оба типизированы.
    expect(source).toContain("WORKER_FAILURE_CODES.navigation");
    expect(source).toContain("WORKER_FAILURE_CODES.runtime");
  });

  test("geometry evaluate function is self-contained and uses the shared union vector", () => {
    expect(collectGeometry.toString()).toContain("rectUnion");
    expect(unionRects([{left:1,top:4,right:5,bottom:8},{left:-2,top:6,right:3,bottom:10}])).toEqual({left:-2,top:4,right:5,bottom:10,width:7,height:6});
  });
});
