import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Строгая readiness 2.0 в реальном chromium (план `docs/plans/2026-08-03-renderer-contract-2.md`
 * §5 **R4**, критерий K3).
 *
 * Что доказывается — ровно три дыры §1.4 плана, каждая своей фикстурой и своим кодом:
 * - **нет шрифтового ассета** → `font_face_missing` (face объявлен темой, применён компонентом, но
 *   браузеру его нечем нарисовать);
 * - **битый `<img>`** рядом с живым → `image_load_failed` (до волны такой кадр объявлялся готовым:
 *   критерий «есть хоть какой-то растр» выполнялся соседней картинкой);
 * - **поздняя мутация layout** → `layout_unstable` за ≤3 попытки перемеры.
 *
 * Строгость включается **политикой профиля** (N10): раны ставятся с `policy: "pixel-strict-v1"`,
 * интерактивные пути и `default-v1` этой спекой не затрагиваются — и это отдельно проверяется
 * четвёртым тестом (тот же компонент под `default-v1` строгих кодов не даёт).
 *
 * Живёт в `e2e/preview/`: только preview-проект поднимает `SERVE_DIST` (иначе капчур — 501) и
 * `EASYUI_ACCEPTANCE_MATRIX=1` (иначе acceptance-ручки отвечают 404).
 */

/** Фикстуры разведены по ДС: гейт переиспользования сравнивает исходники внутри одной системы. */
const FONT_DS = "e2e-strictness-font";
const IMAGE_DS = "e2e-strictness-image";
const LAYOUT_DS = "e2e-strictness-layout";
const FONT_ID = "e2e-strict-font";
const IMAGE_ID = "e2e-strict-image";
const LAYOUT_ID = "e2e-strict-layout";

/**
 * woff2-заголовок с мусорным телом: ассет существует (тема без существующего ассета не
 * публикуется — `validateThemeAssets`), а face из него не рождается. Это и есть «нет font asset»
 * с точки зрения кадра: семейство объявлено, применено и нарисовать его нечем.
 */
const BROKEN_WOFF2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
const HEALTHY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
  "01f15c4890000000d49444154789c6360000002000100055c1a2a0000000049454e44ae426082",
  "hex",
);

const FONT_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Strictness probe: text in a theme family whose font file never becomes a face",
  atomicLevel: "atom" as const,
  examples: { card: { label: "1 234 " } },
};

export default function StrictFont({ props }: EasyUIComponentProps<{ label: string }>) {
  return (
    <div style={{ width: 200, padding: 12, fontFamily: '"E2E Strict Face", sans-serif', fontSize: 18 }}>
      <span>{props.label}</span>
    </div>
  );
}
`;

/**
 * id несуществующего ассета собирается конкатенацией: publish пинует все литералы
 * `asset_[0-9a-f]{64}` исходника и 422-ит неизвестный (`ComponentRepo.pinAssets`).
 */
const IMAGE_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Strictness probe: a broken img next to a healthy one",
  atomicLevel: "atom" as const,
  examples: { card: { label: "Card" } },
};

const MISSING = "asset_".concat("1".repeat(64));

export default function StrictImage({ props }: EasyUIComponentProps<{ label: string }>) {
  return (
    <div style={{ width: 200, padding: 12, display: "flex", gap: 8 }}>
      <img src={\`/api/assets/\${MISSING}\`} alt="broken" width={32} height={32} />
      <span>{props.label}</span>
    </div>
  );
}
`;

/**
 * Layout, который не устаивается: высота меняется **каждый кадр** ~2 с после монтирования.
 * Одиночный поздний скачок ловился бы гонкой (см. `corpus-late-layout-mutation`), а непрерывное
 * движение — детерминированный вход стабилизации: три попытки перемеры обязаны разойтись.
 * Через 2 с движение прекращается, поэтому кадр всё же снимается и джоба доходит до вердикта.
 */
const LAYOUT_SOURCE = `import { useEffect, useRef } from "react";
import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Strictness probe: layout that keeps moving after the frame settle window",
  atomicLevel: "atom" as const,
  examples: { card: { label: "Card" } },
};

export default function StrictLayout({ props }: EasyUIComponentProps<{ label: string }>) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const startedAt = Date.now();
    let raf = 0;
    let tick = 0;
    const step = () => {
      const node = ref.current;
      if (node) node.style.height = String(40 + (tick % 24)) + "px";
      tick += 1;
      if (Date.now() - startedAt < 2000) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div style={{ width: 200, padding: 12 }}>
      <div ref={ref} style={{ height: 40, background: "rgba(255,77,77,0.18)" }}>{props.label}</div>
    </div>
  );
}
`;

interface RunView { status: string; failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[] }
interface CaseView {
  caseId: string;
  verdict: string;
  gates: { gate: string; status: string; detail?: string; metrics?: Record<string, unknown> }[];
}
interface ReadinessMetrics {
  met: boolean | null;
  reason: string | null;
  codes: { code: string; severity: string; detail: string; ref?: string }[];
  policyHash: string | null;
  expectedPolicyHash: string;
  fontManifestHash: string | null;
  layout: { stable: boolean; attempts: number; elementKey: string | null } | null;
  imageDetails: { url: string; decoded: boolean }[] | null;
  fontFaces: { family: string; status: string; required?: boolean; checked?: boolean }[];
}

async function upload(request: APIRequestContext, bytes: Buffer, mime: string): Promise<string> {
  const response = await request.post("/api/assets", { data: bytes, headers: { "content-type": mime } });
  expect([201, 200], await response.text()).toContain(response.status());
  const { id } = await response.json() as { id: string };
  return id;
}

async function ensureDesignSystem(request: APIRequestContext, id: string): Promise<void> {
  const system = await request.post("/api/design-systems", { data: { id, name: `E2E Strictness ${id}`, description: "Design system for the capture strictness e2e" } });
  expect([201, 409], await system.text()).toContain(system.status());
}

async function ensureComponent(request: APIRequestContext, designSystem: string, id: string, name: string, source: string): Promise<void> {
  const existing = await request.get(`/api/components/${id}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: { id, name, source, designSystem, intent: "Фикстура строгой readiness капчура (R4)" },
  });
  expect(created.status(), await created.text()).toBe(201);
}

async function createCandidate(request: APIRequestContext, componentId: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request.post(`/api/components/${componentId}/candidates`, { data: {} });
    if (response.status() === 200) return (await response.json() as { candidateId: string }).candidateId;
    expect([429], `${response.status()}: ${await response.text()}`).toContain(response.status());
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("candidate creation stayed throttled for 60s");
}

async function pollRun(request: APIRequestContext, runId: string): Promise<RunView> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await request.get(`/api/acceptance-runs/${runId}`);
    expect(response.status()).toBe(200);
    const run = await response.json() as RunView;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("acceptance run did not terminalize within 240s");
}

async function runStrict(request: APIRequestContext, candidateId: string, policy = "pixel-strict-v1"): Promise<CaseView[]> {
  const started = await request.post("/api/acceptance-runs", { data: { candidateId, refresh: "all", policy } });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = await started.json() as { runId: string };
  await pollRun(request, runId);
  const casesResponse = await request.get(`/api/acceptance-runs/${runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  return (await casesResponse.json() as { cases: CaseView[] }).cases;
}

const readinessOf = (view: CaseView): { status: string; detail?: string; metrics: ReadinessMetrics } => {
  const gate = view.gates.find((item) => item.gate === "readiness");
  if (!gate) throw new Error(`case ${view.caseId} has no readiness gate: ${JSON.stringify(view.gates.map((item) => item.gate))}`);
  return { status: gate.status, ...(gate.detail === undefined ? {} : { detail: gate.detail }), metrics: gate.metrics as unknown as ReadinessMetrics };
};

const codesOf = (view: CaseView): string[] => readinessOf(view).metrics.codes.map((code) => code.code);

test("нет шрифтового ассета темы ⇒ font_face_missing", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureDesignSystem(request, FONT_DS);
  const fontAsset = await upload(request, BROKEN_WOFF2, "font/woff2");
  const theme = await request.patch(`/api/design-systems/${FONT_DS}`, {
    // Схема темы принимает число либо `normal|bold` (`weightSchema`): диапазон variable-шрифта
    // темой не объявляется, его нормализацию проверяет unit `fontShorthandWeight`.
    data: { fonts: [{ family: "E2E Strict Face", src: fontAsset, weight: 400 }], baseVersion: 0 },
  });
  expect([200, 409], await theme.text()).toContain(theme.status());
  await ensureComponent(request, FONT_DS, FONT_ID, "StrictFont", FONT_SOURCE);

  const cases = await runStrict(request, await createCandidate(request, FONT_ID));
  const readiness = readinessOf(cases[0]!);

  // Политика поверхности — политика строгого профиля, а не «какая-то своя».
  expect(readiness.metrics.policyHash).toBe(readiness.metrics.expectedPolicyHash);
  expect(readiness.status).toBe("fail");
  expect(readiness.metrics.met).toBe(false);
  expect(codesOf(cases[0]!)).toContain("font_face_missing");
  const missing = readiness.metrics.codes.find((code) => code.code === "font_face_missing")!;
  expect(missing.severity).toBe("error");
  expect(missing.ref).toBe("E2E Strict Face");
  // Манифест шрифтов доехал до поверхности — иначе требовать было бы нечего (правило T-M10).
  expect(readiness.metrics.fontManifestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(readiness.metrics.fontFaces.some((face) => face.required === true && face.checked === false)).toBe(true);
  expect(readiness.detail).toContain("font_face_missing");
});

test("битый <img> рядом с живым ⇒ image_load_failed", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureDesignSystem(request, IMAGE_DS);
  await upload(request, HEALTHY_PNG, "image/png");
  await ensureComponent(request, IMAGE_DS, IMAGE_ID, "StrictImage", IMAGE_SOURCE);

  const cases = await runStrict(request, await createCandidate(request, IMAGE_ID));
  const readiness = readinessOf(cases[0]!);

  expect(readiness.status).toBe("fail");
  expect(codesOf(cases[0]!)).toContain("image_load_failed");
  const failed = readiness.metrics.codes.find((code) => code.code === "image_load_failed")!;
  expect(failed.ref).toContain("/api/assets/asset_1111");
  // Пофайловое доказательство строгого декода — не счётчик, а список с интринсиками.
  expect(readiness.metrics.imageDetails?.some((detail) => detail.decoded === false)).toBe(true);
});

test("layout, который продолжает двигаться, ⇒ layout_unstable за ≤3 попытки", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureDesignSystem(request, LAYOUT_DS);
  await ensureComponent(request, LAYOUT_DS, LAYOUT_ID, "StrictLayout", LAYOUT_SOURCE);

  const cases = await runStrict(request, await createCandidate(request, LAYOUT_ID));
  const readiness = readinessOf(cases[0]!);

  expect(readiness.status).toBe("fail");
  expect(codesOf(cases[0]!)).toContain("layout_unstable");
  expect(readiness.metrics.layout).toMatchObject({ stable: false });
  // Потолок политики — три попытки: цикл не имеет права стоить кадру больше.
  expect(readiness.metrics.layout!.attempts).toBeLessThanOrEqual(3);
  expect(readiness.metrics.layout!.elementKey).not.toBeNull();
});

test("строгость приходит политикой профиля: под default-v1 те же фикстуры кодов не дают", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureDesignSystem(request, LAYOUT_DS);
  await ensureComponent(request, LAYOUT_DS, LAYOUT_ID, "StrictLayout", LAYOUT_SOURCE);

  const cases = await runStrict(request, await createCandidate(request, LAYOUT_ID), "default-v1");
  const readiness = readinessOf(cases[0]!);

  expect(readiness.metrics.policyHash).toBe(readiness.metrics.expectedPolicyHash);
  // v1 не меряет layout повторно и не заводит строгих кодов — поведение доволновое.
  expect(readiness.metrics.layout).toBeNull();
  expect(codesOf(cases[0]!)).not.toContain("layout_unstable");
});
