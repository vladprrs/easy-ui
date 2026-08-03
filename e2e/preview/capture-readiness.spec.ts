import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Deterministic Capture Readiness в реальном chromium (план 2026-08-03 §5 W4).
 *
 * Проверяется то, чего не может unit-тест: поверхность действительно исполняет политику и
 * публикует доказательство, гейт `readiness` действительно судит **тот самый** кадр, а кадр с
 * незагруженным ассетом действительно теряет право на геометрический вердикт (инвариант D5).
 *
 * Две фикстуры:
 * - `e2e-readiness-ok` — обычный компонент: готовность достигается, доказательство несёт
 *   наблюдённые токены темы (вход импакт-анализа W6) и стабильный `captureEnvFingerprint`;
 * - `e2e-readiness-blocked` — компонент с `img` на внешний хост: egress-граница капчура его
 *   рубит, картинка не декодируется → `readiness` fail с `pendingRequests`, а `geometry`/
 *   `determinism` не выдают вердикта.
 *
 * Живёт в `e2e/preview/`: только preview-проект поднимает `SERVE_DIST` (иначе капчур — 501) и
 * `EASYUI_ACCEPTANCE_MATRIX=1` (иначе acceptance-ручки отвечают 404).
 */

/**
 * Фикстуры живут в **разных** ДС: гейт переиспользования (`component_reuse_required`) сравнивает
 * структуру исходников внутри одной системы, а обе карточки намеренно почти одинаковы — вся
 * разница в одном `img`.
 */
const OK_DS_ID = "e2e-capture-readiness";
const BLOCKED_DS_ID = "e2e-capture-readiness-blocked";
const OK_ID = "e2e-readiness-ok";
const BLOCKED_ID = "e2e-readiness-blocked";

const OK_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Readiness probe: a plain card that references theme tokens",
  atomicLevel: "atom" as const,
  examples: { card: { label: "Card" } },
};

export default function ReadinessOk({ props }: EasyUIComponentProps<{ label: string }>) {
  return (
    <div style={{ width: 160, height: 64, background: "var(--eui-color-bg-default)", color: "var(--eui-color-fg-primary)" }}>
      <span>{props.label}</span>
    </div>
  );
}
`;

/**
 * Внешний URL — единственный способ получить в headless-капчуре честно **незагруженный** ресурс:
 * egress закрыт deny-прокси и allowlist'ом, поэтому запрос гарантированно не доедет, а картинка
 * останется без растра. Задержкой этого не добиться: воспроизводимого «медленного» ресурса в
 * закрытом контуре не существует.
 */
const BLOCKED_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Readiness probe: a card whose late theme icon never arrives (egress-blocked)",
  atomicLevel: "atom" as const,
  examples: { card: { label: "Card" } },
};

export default function ReadinessBlocked({ props }: EasyUIComponentProps<{ label: string }>) {
  return (
    <div style={{ width: 160, height: 64, background: "var(--eui-color-bg-default)" }}>
      <img src="https://blocked.example/late-icon.svg" alt="late icon" width={24} height={24} />
      <span>{props.label}</span>
    </div>
  );
}
`;

interface RunView {
  status: string;
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

interface ReadinessMetrics {
  met: boolean | null;
  reason: string | null;
  policyHash: string | null;
  expectedPolicyHash: string;
  captureEnvFingerprint: string | null;
  pendingRequests: string[];
  fontFaces: { family: string; status: string }[];
  images: { total: number; decoded: number; failed: number } | null;
  framesWaited: number | null;
  animationsDisabled: boolean | null;
  themeResources: { tokens: string[]; icons: string[]; images: string[] };
}

interface CaseView {
  caseId: string;
  verdict: string;
  gates: { gate: string; status: string; detail?: string; metrics?: Record<string, unknown> }[];
  artifacts: { name: string }[];
}

async function ensureComponent(request: APIRequestContext, designSystem: string, id: string, name: string, source: string): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: designSystem, name: `E2E Capture Readiness ${id}`, description: "Design system for the readiness e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${id}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: { id, name, source, designSystem, intent: "Фикстура приёмки readiness капчура (W4)" },
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

async function runOnce(request: APIRequestContext, candidateId: string): Promise<{ run: RunView; cases: CaseView[] }> {
  const started = await request.post("/api/acceptance-runs", { data: { candidateId, refresh: "all" } });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = await started.json() as { runId: string };
  const run = await pollRun(request, runId);
  const casesResponse = await request.get(`/api/acceptance-runs/${runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  const { cases } = await casesResponse.json() as { cases: CaseView[] };
  return { run, cases };
}

/** Постановка кандидата делит слоты validate с прочими спеками: ограниченный ретрай — контракт ручки. */
async function createCandidate(request: APIRequestContext, componentId: string): Promise<{ candidateId: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request.post(`/api/components/${componentId}/candidates`, { data: {} });
    if (response.status() === 200) return await response.json() as { candidateId: string };
    expect([429], `${response.status()}: ${await response.text()}`).toContain(response.status());
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("candidate creation stayed throttled for 60s");
}

const readinessOf = (view: CaseView): { status: string; detail?: string; metrics: ReadinessMetrics } => {
  const gate = view.gates.find((item) => item.gate === "readiness");
  if (!gate) throw new Error(`case ${view.caseId} has no readiness gate: ${JSON.stringify(view.gates.map((item) => item.gate))}`);
  return { status: gate.status, ...(gate.detail === undefined ? {} : { detail: gate.detail }), metrics: gate.metrics as unknown as ReadinessMetrics };
};

test("a settled capture proves its readiness and reports the same environment fingerprint twice", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureComponent(request, OK_DS_ID, OK_ID, "ReadinessOk", OK_SOURCE);
  const candidate = await createCandidate(request, OK_ID);

  const first = await runOnce(request, candidate.candidateId);
  expect(first.run.status, JSON.stringify(first.run.failedCases)).toBe("pass");
  const readiness = readinessOf(first.cases[0]!);

  expect(readiness.status).toBe("pass");
  expect(readiness.metrics.met).toBe(true);
  // Политика поверхности — ровно политика профиля приёмки, не «какая-то своя».
  expect(readiness.metrics.policyHash).toBe(readiness.metrics.expectedPolicyHash);
  expect(readiness.metrics.animationsDisabled).toBe(true);
  expect(readiness.metrics.framesWaited).toBe(2);
  expect(readiness.metrics.pendingRequests).toEqual([]);
  // Шрифты действительно дождались: применённое семейство приехало со статусом `loaded`.
  expect(readiness.metrics.fontFaces.length).toBeGreaterThan(0);
  expect(readiness.metrics.fontFaces.some((face) => face.status === "loaded")).toBe(true);
  // `themeResources` обязательны — это вход импакт-анализа W6 (триаж R2-14).
  expect(readiness.metrics.themeResources.tokens).toContain("--eui-color-bg-default");
  expect(readiness.metrics.themeResources.tokens).toContain("--eui-color-fg-primary");
  expect(readiness.metrics.captureEnvFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(first.cases[0]!.artifacts.map((artifact) => artifact.name)).toContain("readiness.json");

  // Два подряд захвата в одной среде — один и тот же отпечаток окружения.
  const second = await runOnce(request, candidate.candidateId);
  expect(second.run.status).toBe("pass");
  expect(readinessOf(second.cases[0]!).metrics.captureEnvFingerprint).toBe(readiness.metrics.captureEnvFingerprint);
});

test("a frame whose asset never arrives fails readiness and gets no geometry verdict", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureComponent(request, BLOCKED_DS_ID, BLOCKED_ID, "ReadinessBlocked", BLOCKED_SOURCE);
  const candidate = await createCandidate(request, BLOCKED_ID);

  const { run, cases } = await runOnce(request, candidate.candidateId);
  expect(run.status).toBe("fail");
  const readiness = readinessOf(cases[0]!);

  expect(readiness.status).toBe("fail");
  expect(readiness.metrics.met).toBe(false);
  expect(readiness.metrics.reason).toContain("images_failed");
  expect(readiness.metrics.images).toMatchObject({ total: 1, decoded: 0, failed: 1 });
  expect(readiness.metrics.pendingRequests.some((item) => item.includes("late-icon.svg"))).toBe(true);
  expect(readiness.detail).toContain("late-icon.svg");

  // Инвариант D5: сравнивающие гейты вердикта не выдают — кадр снят до готовности.
  for (const name of ["geometry", "determinism"]) {
    const gate = cases[0]!.gates.find((item) => item.gate === name);
    if (!gate) continue;
    expect(gate.status, `${name} must not judge a non-ready frame`).toBe("indeterminate");
    expect(gate.metrics?.skippedByReadiness).toBe(true);
  }
  expect(cases[0]!.verdict).toBe("fail");
});
