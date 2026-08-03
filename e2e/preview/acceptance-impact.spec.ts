import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Импакт и частичная пересъёмка на реальном контуре (план 2026-08-03 §3 D6, §5 W6).
 *
 * Предмет — то, чего не может unit-тест: наблюдённые ресурсы приезжают из **настоящего** chromium
 * (readiness-evidence кадра, волна W4), а не из заглушки капчура. Сценарий буквально повторяет
 * мотивировку D6: у компонента два состояния, каждое рисует свой `img` из реестра ассетов; замена
 * одного asset-id в исходнике обязана стоить **одну** пересъёмку, а не две.
 *
 * Живёт в `e2e/preview/`: только preview-проект поднимает `SERVE_DIST` (иначе капчур — 501) и
 * `EASYUI_ACCEPTANCE_MATRIX=1` (иначе acceptance-ручки отвечают 404).
 */

const DS_ID = "e2e-acceptance-impact";
const COMPONENT_ID = "e2e-impact-probe";

/** 1×1 PNG — содержимое неважно, важен адрес: asset-id входит и в исходник, и в evidence кадра. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** Второй ассет обязан отличаться байтами: иначе content-addressed реестр вернёт тот же id. */
const PNG_BASE64_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BASE64_C = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Исходник параметризован **только** двумя литералами ассетов: подстановка другого id обязана
 * оставить `sourceShapeHash` неизменным (в нём все `asset_<sha256>` заменены плейсхолдером).
 */
const sourceFor = (assetA: string, assetB: string): string => `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

const A = "/api/assets/${assetA}";
const B = "/api/assets/${assetB}";

export const definition = {
  props: z.strictObject({ variant: z.enum(["a", "b"]) }),
  description: "Impact probe: renders one of two registry images by variant",
  atomicLevel: "atom" as const,
  examples: { "uses-a": { variant: "a" }, "uses-b": { variant: "b" } },
};

export default function ImpactProbe({ props }: EasyUIComponentProps<{ variant: "a" | "b" }>) {
  return (
    <div style={{ width: 120, height: 60, background: "#fff", padding: 8 }}>
      <img src={props.variant === "a" ? A : B} width={32} height={32} alt="" />
    </div>
  );
}
`;

interface RunView {
  status: string;
  progress: { total: number; completed: number; reused: number; failed: number };
  impact: ImpactReport | null;
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

interface ImpactReport {
  basis: string;
  changedAssets: string[];
  changedTokens: string[];
  affectedCases: string[];
  unaffectedCases: string[];
  recaptureCount: number;
  reason: string;
}

async function uploadAsset(request: APIRequestContext, name: string, base64: string): Promise<string> {
  const upload = await request.post("/api/assets", {
    multipart: { file: { name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") } },
  });
  expect([200, 201], await upload.text()).toContain(upload.status());
  return (await upload.json() as { id: string }).id;
}

/** Постановка кандидата троттлится теми же слотами, что validate (429 — часть контракта ручки). */
async function createCandidate(request: APIRequestContext): Promise<{ candidateId: string; rev: number }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request.post(`/api/components/${COMPONENT_ID}/candidates`, { data: {} });
    if (response.status() === 200) return await response.json() as { candidateId: string; rev: number };
    expect([429], `${response.status()}: ${await response.text()}`).toContain(response.status());
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("candidate creation stayed throttled for 60s");
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

test("замена одного asset-id: impact видит один затронутый случай, частичный ран снимает только его", async ({ request }) => {
  test.setTimeout(900_000);

  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Acceptance Impact", description: "Design system for the acceptance impact e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());

  const assetA = await uploadAsset(request, "impact-a.png", PNG_BASE64);
  const assetB = await uploadAsset(request, "impact-b.png", PNG_BASE64_B);
  const assetC = await uploadAsset(request, "impact-c.png", PNG_BASE64_C);
  expect(new Set([assetA, assetB, assetC]).size).toBe(3);

  // Фикстура пересоздаётся под свежие ассеты: их id зависят от содержимого, а исходник — от id.
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) {
    const head = await existing.json() as { headRev: number };
    const saved = await request.put(`/api/components/${COMPONENT_ID}`, { data: { source: sourceFor(assetA, assetB), baseRev: head.headRev } });
    expect(saved.status(), await saved.text()).toBe(200);
  } else {
    const created = await request.post("/api/components", {
      data: {
        id: COMPONENT_ID, name: "ImpactProbe", source: sourceFor(assetA, assetB), designSystem: DS_ID,
        intent: "Рисует одно из двух изображений реестра по варианту — фикстура импакт-анализа",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
  }

  // ------------------------------------------------------------------ baseline
  const baselineCandidate = await createCandidate(request);
  const startedBaseline = await request.post("/api/acceptance-runs", { data: { candidateId: baselineCandidate.candidateId } });
  expect(startedBaseline.status(), await startedBaseline.text()).toBe(202);
  const queuedBaseline = await startedBaseline.json() as { runId: string; cases: number };
  expect(queuedBaseline.cases).toBe(2);
  const baselineRun = await pollRun(request, queuedBaseline.runId);
  expect(baselineRun.status, JSON.stringify(baselineRun.failedCases)).toBe("pass");
  expect(baselineRun.impact).toBeNull();

  // Наблюдённые ресурсы — реальные: каждый случай видел ровно свой ассет.
  const casesResponse = await request.get(`/api/acceptance-runs/${queuedBaseline.runId}/cases`);
  const { cases } = await casesResponse.json() as {
    cases: { caseId: string; gates: { gate: string; metrics?: { themeResources?: { images?: string[] } } }[] }[];
  };
  const imagesOf = (caseId: string): string[] =>
    cases.find((item) => item.caseId === caseId)!.gates.find((gate) => gate.gate === "readiness")!.metrics!.themeResources!.images!;
  expect(imagesOf("uses-a")).toEqual([assetA]);
  expect(imagesOf("uses-b")).toEqual([assetB]);

  // ----------------------------------------------- правка: ASSET_A → ASSET_C
  const head = await request.get(`/api/components/${COMPONENT_ID}`);
  const currentRev = (await head.json() as { headRev: number }).headRev;
  const saved = await request.put(`/api/components/${COMPONENT_ID}`, {
    data: { source: sourceFor(assetC, assetB), baseRev: currentRev },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  const nextCandidate = await createCandidate(request);
  expect(nextCandidate.candidateId).not.toBe(baselineCandidate.candidateId);

  // ------------------------------------------------------------ dry-run импакт
  const impactResponse = await request.post(`/api/components/${COMPONENT_ID}/impact`, {
    data: { candidateId: nextCandidate.candidateId, baselineRunId: queuedBaseline.runId },
  });
  expect(impactResponse.status(), await impactResponse.text()).toBe(200);
  const impact = await impactResponse.json() as ImpactReport;
  expect(impact.basis, impact.reason).toBe("asset-only");
  expect(impact.changedAssets.sort()).toEqual([assetA, assetC].sort());
  expect(impact.affectedCases).toEqual(["uses-a"]);
  expect(impact.unaffectedCases).toEqual(["uses-b"]);
  expect(impact.recaptureCount).toBe(1);

  // ------------------------------------------------------- частичная пересъёмка
  const startedPartial = await request.post("/api/acceptance-runs", {
    data: { candidateId: nextCandidate.candidateId, baselineRunId: queuedBaseline.runId },
  });
  expect(startedPartial.status(), await startedPartial.text()).toBe(202);
  const queuedPartial = await startedPartial.json() as { runId: string; impact: ImpactReport };
  expect(queuedPartial.impact.basis).toBe("asset-only");

  const partialRun = await pollRun(request, queuedPartial.runId);
  expect(partialRun.status, JSON.stringify(partialRun.failedCases)).toBe("pass");
  // Один случай переиспользован по импакту, второй снят заново — это и есть KPI волны.
  expect(partialRun.progress.reused).toBe(1);
  expect(partialRun.impact?.basis).toBe("asset-only");

  const partialCases = await (await request.get(`/api/acceptance-runs/${queuedPartial.runId}/cases`)).json() as {
    cases: { caseId: string; verdict: string; reuseReason: string | null }[];
  };
  const reuseReasons = Object.fromEntries(partialCases.cases.map((item) => [item.caseId, item.reuseReason]));
  expect(reuseReasons).toEqual({ "uses-a": null, "uses-b": "impact:asset-only" });
  expect(partialCases.cases.every((item) => item.verdict === "pass")).toBe(true);

  // Перенесённый вердикт записан под новым отпечатком: следующий ран реюзает его обычным путём.
  const repeat = await request.post("/api/acceptance-runs", { data: { candidateId: nextCandidate.candidateId } });
  expect(repeat.status(), await repeat.text()).toBe(202);
  const repeated = await pollRun(request, (await repeat.json() as { runId: string }).runId);
  expect(repeated.status).toBe("pass");
  expect(repeated.progress.reused).toBe(repeated.progress.total);
});
