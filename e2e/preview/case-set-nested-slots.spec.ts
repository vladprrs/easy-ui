import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Вложенные слот-биндинги против реального Bun preview-сервера (план 2026-08-06 §W6).
 *
 * Проверяемый результат строки 1 фидбэка — «Lead Block acceptance получает реальное содержимое
 * вложенной кнопки»: родитель-**кандидат** (неопубликованный) набивается опубликованной строкой, а
 * та — опубликованной кнопкой во **вложенном** слоте. Доказательство того, что поддерево доехало до
 * пикселей, — два случая с байт-в-байт одинаковыми props родителя и одинаковой строкой, которые
 * отличаются **только** подписью вложенной кнопки: до этой волны такой манифест либо отвергался
 * схемой, либо (при плоской съёмке) дал бы два одинаковых кадра. Здесь их `render.png` обязаны
 * разойтись по sha256.
 *
 * Живёт в `e2e/preview/` по той же причине, что `acceptance-run.spec.ts`: только preview-проект
 * поднимает `SERVE_DIST` и `EASYUI_ACCEPTANCE_MATRIX=1`.
 */

const DS_ID = "e2e-nested-slots";
const BUTTON_ID = "e2e-nested-slot-button";
const ROW_ID = "e2e-nested-slot-row";
const PANEL_ID = "e2e-nested-slot-panel";

const BUTTON_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Nested slot probe: a button-looking box with a static label",
  atomicLevel: "atom" as const,
  examples: { base: { label: "Pay" } },
};

export default function NestedSlotButton({ props }: EasyUIComponentProps<{ label: string }>) {
  return <span style={{ padding: 4, background: "#2f6fed", color: "#fff" }}>{props.label}</span>;
}
`;

const ROW_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({}),
  description: "Nested slot probe: a row that renders its action slot",
  atomicLevel: "molecule" as const,
  // Молекула требует объяснения владения (atomic policy) — иначе publish отвечает 422.
  ownership: { reason: "Slot-aware probe fixture: the nested slot wiring is the subject of the test" },
  capabilities: { namedSlots: true } as const,
  slots: ["action"],
  examples: { base: {} },
};

export default function NestedSlotRow({ slots }: EasyUIComponentProps<Record<string, never>>) {
  return <div style={{ padding: 4, background: "#fff", color: "#000" }}>row {slots.action}</div>;
}
`;

const PANEL_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ title: z.string() }),
  description: "Nested slot probe: a panel that renders its items slot",
  atomicLevel: "molecule" as const,
  // Молекула требует объяснения владения (atomic policy) — иначе publish отвечает 422.
  ownership: { reason: "Slot-aware probe fixture: the nested slot wiring is the subject of the test" },
  capabilities: { namedSlots: true } as const,
  slots: ["items"],
  examples: { base: { title: "Panel" } },
};

export default function NestedSlotPanel({ props, slots }: EasyUIComponentProps<{ title: string }>) {
  return <section style={{ padding: 8, background: "#fff", color: "#000" }}>{props.title}{slots.items}</section>;
}
`;

interface RunView {
  status: string;
  progress: { total: number; completed: number; reused: number; failed: number };
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

async function ensureComponent(request: APIRequestContext, id: string, name: string, source: string, publish: boolean): Promise<void> {
  const existing = await request.get(`/api/components/${id}`);
  if (existing.status() !== 200) {
    const created = await request.post("/api/components", {
      data: { id, name, source, designSystem: DS_ID, intent: `Проба вложенных слот-биндингов: ${name}` },
    });
    expect(created.status(), await created.text()).toBe(201);
  }
  if (!publish) return;
  const published = await request.post(`/api/components/${id}/publish`, { data: { baseRev: 1 } });
  expect([201, 409], await published.text()).toContain(published.status());
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Nested Slots", description: "Design system for the nested slot-bindings e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  await ensureComponent(request, BUTTON_ID, "NestedSlotButton", BUTTON_SOURCE, true);
  await ensureComponent(request, ROW_ID, "NestedSlotRow", ROW_SOURCE, true);
  // Родитель остаётся **неопубликованным**: приёмка снимает его кандидата — ровно тот first-publish
  // сценарий, ради которого волна и делалась.
  await ensureComponent(request, PANEL_ID, "NestedSlotPanel", PANEL_SOURCE, false);
}

/** Постановка кандидата троттлится теми же двумя глобальными слотами, что и validate. */
async function createCandidate(request: APIRequestContext, componentId: string): Promise<{ candidateId: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request.post(`/api/components/${componentId}/candidates`, { data: {} });
    if (response.status() === 200) return await response.json() as { candidateId: string };
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

const nestedCase = (id: string, label: string) => ({
  id,
  props: { title: "Panel" },
  slotBindings: {
    items: [{
      type: "NestedSlotRow", version: 1,
      slotBindings: { action: [{ type: "NestedSlotButton", version: 1, props: { label } }] },
    }],
  },
});

const nestedManifest = (cases: unknown[]) => ({
  manifestVersion: 1,
  componentId: PANEL_ID,
  capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
  cases,
});

test("nested slot bindings: candidate parent → published row → published button reaches the frame", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureFixture(request);

  const put = await request.put(`/api/components/${PANEL_ID}/case-sets`, {
    data: { manifest: nestedManifest([nestedCase("pay", "Pay"), nestedCase("cancel", "Cancel")]) },
  });
  expect(put.status(), await put.text()).toBe(200);
  const caseSet = await put.json() as { caseSetId: string; cases: number; coverage: { frameCases: number } };
  expect(caseSet.caseSetId).toMatch(/^cset_[0-9a-f]{64}$/);
  // Одинаковые props родителя и разное содержимое **вложенного** слота — два кадра, а не дубликат.
  expect(caseSet.coverage.frameCases).toBe(2);

  const candidate = await createCandidate(request, PANEL_ID);
  const started = await request.post("/api/acceptance-runs", {
    data: { candidateId: candidate.candidateId, caseSetId: caseSet.caseSetId },
  });
  expect(started.status(), await started.text()).toBe(202);
  const queued = await started.json() as { runId: string; cases: number };
  expect(queued.cases).toBe(2);

  const run = await pollRun(request, queued.runId);
  expect(run.status, JSON.stringify(run.failedCases)).toBe("pass");
  expect(run.progress).toMatchObject({ total: 2, completed: 2, failed: 0 });

  const casesResponse = await request.get(`/api/acceptance-runs/${queued.runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  const { cases } = await casesResponse.json() as {
    cases: { caseId: string; verdict: string; aliasOfCaseId: string | null; artifacts: { name: string; sha256: string }[] }[];
  };
  expect(cases.map((item) => item.caseId).sort()).toEqual(["cancel", "pay"]);
  const frames = new Map(cases.map((item) => [item.caseId, item.artifacts.find((artifact) => artifact.name === "render.png")!]));
  for (const item of cases) {
    expect({ caseId: item.caseId, verdict: item.verdict, alias: item.aliasOfCaseId })
      .toEqual({ caseId: item.caseId, verdict: "pass", alias: null });
  }
  // Единственное различие двух кадров — подпись кнопки во вложенном слоте: разошлись байты ⇒
  // поддерево действительно отрисовалось.
  expect(frames.get("pay")!.sha256).not.toBe(frames.get("cancel")!.sha256);

  // Вложенный слот судится по definition **запиненной публикации** родителя: слота `trailing` у
  // строки нет, и отказ приезжает уже на PUT, а не тихой потерей детей в кадре. (Потолки глубины и
  // тотала узлов покрыты юнит-тестами `server/acceptance/caseSets.test.ts`.)
  const unknownSlot = await request.put(`/api/components/${PANEL_ID}/case-sets`, {
    data: {
      manifest: nestedManifest([{
        id: "unknown", props: { title: "Panel" },
        slotBindings: {
          items: [{
            type: "NestedSlotRow", version: 1,
            slotBindings: { trailing: [{ type: "NestedSlotButton", version: 1, props: { label: "x" } }] },
          }],
        },
      }]),
    },
  });
  expect(unknownSlot.status()).toBe(422);
  expect(await unknownSlot.json() as { error: { code: string } }).toMatchObject({ error: { code: "slot_unknown" } });
});
