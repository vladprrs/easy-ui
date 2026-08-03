import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Case-set-манифесты против реального Bun preview-сервера (план 2026-08-03 §5 W2).
 *
 * Живёт в `e2e/preview/` по той же причине, что и `acceptance-run.spec.ts`: только preview-проект
 * поднимает `SERVE_DIST` и `EASYUI_ACCEPTANCE_MATRIX=1`, без которых гейты `render`/`determinism`
 * не считаются, а ручки набора отвечают 404.
 *
 * Проверяется путь агента целиком: загрузить эталон → опубликовать манифест на 9 случаев
 * (3 уникальных props + алиасы и координаты матрицы 3×3) → поставить ран по `caseSetId` → pass,
 * coverage без пропусков, эталон в строке случая. Эталоны гейтами пока не потребляются (визуальный
 * гейт — следующая волна): предмет теста — постановка и durable-поля, а не пиксельное сравнение.
 */

const DS_ID = "e2e-case-sets";
const COMPONENT_ID = "e2e-case-set-probe";

/** 1×1 PNG с прозрачным пикселем — валиден по magic-байтам серверной проверки. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ tone: z.string(), size: z.string() }),
  description: "Case-set probe: renders its tone and size as static text",
  atomicLevel: "atom" as const,
  examples: { base: { tone: "neutral", size: "s" } },
};

export default function CaseSetProbe({ props }: EasyUIComponentProps<{ tone: string; size: string }>) {
  return <div style={{ padding: 8, background: "#fff", color: "#000" }}>{props.tone}/{props.size}</div>;
}
`;

const TONES = ["neutral", "accent", "muted"];
const SIZES = ["s", "m", "l"];

interface RunView {
  status: string;
  caseSetId: string | null;
  progress: { total: number; completed: number; reused: number; failed: number };
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Case Sets", description: "Design system for the case-set e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: {
      id: COMPONENT_ID, name: "CaseSetProbe", source: SOURCE, designSystem: DS_ID,
      intent: "Показывает тон и размер для приёмки матрицы состояний по case-set-манифесту",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

/**
 * 9 случаев матрицы 3×3: props зависят только от `size`, поэтому уникальных пар props ровно три,
 * а остальные шесть случаев — алиасы своей колонки. Набор покрывает все 9 ячеек, но платит за
 * 3 съёмки — это и есть смысл алиасов (D10: вердикт наследуется, кадр один).
 *
 * Цель алиаса обязана быть **не-алиасом**, поэтому целью колонки назначен её первый тон.
 */
function manifest(referenceAssetId: string): Record<string, unknown> {
  const cases: Record<string, unknown>[] = [];
  for (const tone of TONES) {
    for (const size of SIZES) {
      const id = `${tone}-${size}`;
      const target = `${TONES[0]}-${size}`;
      cases.push({
        id, props: { tone: TONES[0]!, size }, dims: { tone, size },
        ...(id === target ? {} : { aliasOf: target }),
        ...(id === "neutral-s" ? { referenceAssetId, expectedGeometry: { width: 140, height: 96 } } : {}),
      });
    }
  }
  return {
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    dimensions: { tone: TONES, size: SIZES },
    policy: { profile: "default-v1", perCase: { "neutral-s": { maxRawDiffPct: 2 } } },
    cases,
  };
}

async function pollRun(request: APIRequestContext, runId: string): Promise<RunView> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await request.get(`/api/acceptance-runs/${runId}`);
    expect(response.status()).toBe(200);
    const run = await response.json() as RunView;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("acceptance run did not terminalize within 180s");
}

test("case-set manifest → run → pass, coverage without gaps, references on the case rows", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureFixture(request);

  const upload = await request.post("/api/assets", {
    multipart: { file: { name: "case-set-reference.png", mimeType: "image/png", buffer: Buffer.from(PNG_BASE64, "base64") } },
  });
  expect([200, 201], await upload.text()).toContain(upload.status());
  const referenceAssetId = (await upload.json() as { id: string }).id;

  const put = await request.put(`/api/components/${COMPONENT_ID}/case-sets`, { data: { manifest: manifest(referenceAssetId) } });
  expect(put.status(), await put.text()).toBe(200);
  const caseSet = await put.json() as {
    caseSetId: string; cases: number; cached: boolean;
    coverage: { expectedTuples: number; presentTuples: number; missingTuples: unknown[] };
  };
  expect(caseSet.caseSetId).toMatch(/^cset_[0-9a-f]{64}$/);
  expect(caseSet.cases).toBe(9);
  expect(caseSet.coverage).toMatchObject({ expectedTuples: 9, presentTuples: 9, missingTuples: [] });

  // Контентная адресация: повторная публикация того же манифеста — та же строка.
  const again = await request.put(`/api/components/${COMPONENT_ID}/case-sets`, { data: { manifest: manifest(referenceAssetId) } });
  expect(await again.json() as { caseSetId: string; cached: boolean })
    .toMatchObject({ caseSetId: caseSet.caseSetId, cached: true });

  const coverage = await request.get(`/api/case-sets/${caseSet.caseSetId}/coverage`);
  expect(coverage.status()).toBe(200);
  const report = await coverage.json() as { missingTuples: unknown[]; duplicates: unknown[] };
  expect(report.missingTuples).toEqual([]);
  expect(report.duplicates).toEqual([]);

  const candidateResponse = await request.post(`/api/components/${COMPONENT_ID}/candidates`, { data: {} });
  expect(candidateResponse.status(), await candidateResponse.text()).toBe(200);
  const candidate = await candidateResponse.json() as { candidateId: string };

  const started = await request.post("/api/acceptance-runs", { data: { candidateId: candidate.candidateId, caseSetId: caseSet.caseSetId } });
  expect(started.status(), await started.text()).toBe(202);
  const queued = await started.json() as { runId: string; cases: number };
  // Девять случаев манифеста, а не единственный `example` компонента.
  expect(queued.cases).toBe(9);

  const run = await pollRun(request, queued.runId);
  expect(run.status, JSON.stringify(run.failedCases)).toBe("pass");
  expect(run.caseSetId).toBe(caseSet.caseSetId);
  expect(run.progress).toMatchObject({ total: 9, completed: 9, failed: 0 });

  const casesResponse = await request.get(`/api/acceptance-runs/${queued.runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  const { cases } = await casesResponse.json() as {
    cases: { caseId: string; verdict: string; aliasOfCaseId: string | null; referenceAssetId: string | null; artifacts: { name: string }[] }[];
  };
  expect(cases.length).toBe(9);
  const byId = new Map(cases.map((item) => [item.caseId, item]));
  expect(byId.get("neutral-s")!.referenceAssetId).toBe(referenceAssetId);
  expect(byId.get("neutral-s")!.artifacts.map((artifact) => artifact.name)).toContain("render.png");
  // Шесть алиасов наследуют вердикт своих целей и своей съёмки не имеют.
  expect(cases.filter((item) => item.aliasOfCaseId !== null).length).toBe(6);
  for (const item of cases) expect({ caseId: item.caseId, verdict: item.verdict }).toEqual({ caseId: item.caseId, verdict: "pass" });

  // Отказы: несуществующий эталон и case id вне charset evidence-архива.
  const brokenAsset = await request.put(`/api/components/${COMPONENT_ID}/case-sets`, {
    data: {
      manifest: {
        manifestVersion: 1, componentId: COMPONENT_ID,
        capture: { viewport: { width: 390, height: 844 } },
        cases: [{ id: "broken", props: { tone: "neutral", size: "s" }, referenceAssetId: `asset_${"f".repeat(64)}` }],
      },
    },
  });
  expect(brokenAsset.status()).toBe(422);
  expect(await brokenAsset.json() as { error: { code: string } }).toMatchObject({ error: { code: "asset_not_found" } });

  const badCharset = await request.put(`/api/components/${COMPONENT_ID}/case-sets`, {
    data: {
      manifest: {
        manifestVersion: 1, componentId: COMPONENT_ID,
        capture: { viewport: { width: 390, height: 844 } },
        cases: [{ id: "54863:9537", props: { tone: "neutral", size: "s" } }],
      },
    },
  });
  expect(badCharset.status()).toBe(422);
  expect(await badCharset.json() as { error: { code: string } }).toMatchObject({ error: { code: "validation_failed" } });
});
