import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Матричная приёмка кандидата против реального Bun preview-сервера (план 2026-08-03 §5 W1a).
 *
 * Живёт в `e2e/preview/`, а не в `dev/`, осознанно: dev-проект не поднимает `SERVE_DIST`, и
 * `ScreenshotService.available()` вернул бы 501 — гейты `render`/`determinism` без капчура
 * не считаются. Preview-сервер стартует с `EASYUI_ACCEPTANCE_MATRIX=1` (см. `playwright.config.ts`).
 *
 * Проверяется полный путь: кандидат → ран → poll до терминала → per-case вердикты → evidence-zip,
 * и главное свойство фазы — **повторный ран того же кандидата переиспользует все случаи**
 * (`progress.reused === progress.total`), то есть стоит почти ноль.
 */

const DS_ID = "e2e-acceptance";
const COMPONENT_ID = "e2e-acceptance-probe";

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Acceptance probe: renders a single static label",
  atomicLevel: "atom" as const,
  examples: {
    alpha: { label: "Alpha" },
    beta: { label: "Beta" },
    gamma: { label: "Gamma" },
  },
};

export default function AcceptanceProbe({ props }: EasyUIComponentProps<{ label: string }>) {
  return <div style={{ padding: 8, background: "#fff", color: "#000" }}>{props.label}</div>;
}
`;

interface RunView {
  status: string;
  progress: { total: number; completed: number; reused: number; failed: number };
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Acceptance", description: "Design system for the acceptance-run e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: {
      id: COMPONENT_ID, name: "AcceptanceProbe", source: SOURCE, designSystem: DS_ID,
      intent: "Показывает статичную подпись для приёмочного прогона матрицы состояний",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
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

test("candidate → run → cases → evidence, and a repeat run reuses every case", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureFixture(request);

  const candidateResponse = await request.post(`/api/components/${COMPONENT_ID}/candidates`, { data: {} });
  expect(candidateResponse.status(), await candidateResponse.text()).toBe(200);
  const candidate = await candidateResponse.json() as { candidateId: string; status: string; rev: number };
  expect(candidate.candidateId).toMatch(/^cand_[0-9a-f]{64}$/);
  expect(candidate.status).toBe("validated");

  const started = await request.post("/api/acceptance-runs", { data: { candidateId: candidate.candidateId } });
  expect(started.status(), await started.text()).toBe(202);
  const queued = await started.json() as { runId: string; status: string; cases: number };
  expect(queued.status).toBe("queued");
  expect(queued.cases).toBe(3);

  const run = await pollRun(request, queued.runId);
  expect(run.status, JSON.stringify(run.failedCases)).toBe("pass");
  expect(run.progress.total).toBe(3);
  expect(run.progress.completed).toBe(3);
  expect(run.progress.failed).toBe(0);

  const casesResponse = await request.get(`/api/acceptance-runs/${queued.runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  const { cases } = await casesResponse.json() as { cases: { caseId: string; verdict: string; artifacts: { name: string }[] }[] };
  expect(cases.map((item) => item.caseId).sort()).toEqual(["alpha", "beta", "gamma"]);
  for (const item of cases) {
    expect(item.verdict).toBe("pass");
    expect(item.artifacts.map((artifact) => artifact.name)).toContain("render.png");
  }

  const evidence = await request.get(`/api/acceptance-runs/${queued.runId}/evidence`);
  expect(evidence.status()).toBe(200);
  expect(evidence.headers()["content-type"]).toBe("application/zip");
  expect((await evidence.body()).byteLength).toBeGreaterThan(0);

  // A3/D1: тот же кандидат, та же поверхность — все случаи приезжают из кэша результатов.
  const repeatResponse = await request.post("/api/acceptance-runs", { data: { candidateId: candidate.candidateId } });
  expect(repeatResponse.status(), await repeatResponse.text()).toBe(202);
  const repeat = await repeatResponse.json() as { runId: string };
  const repeated = await pollRun(request, repeat.runId);
  expect(repeated.status).toBe("pass");
  expect(repeated.progress.reused).toBe(repeated.progress.total);
});
