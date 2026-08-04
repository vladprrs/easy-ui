import { expect, test, type APIRequestContext } from "@playwright/test";
import pngjs from "pngjs";

/**
 * Cross-renderer guard на визуальных эталонах против реального Bun preview-сервера
 * (план 2026-08-03-renderer-contract-2 §5 **R6**).
 *
 * Спека проверяет обе половины волны на настоящем chromium, а не на моках:
 *
 * 1. **эталон, рождённый серверным капчуром, знает свой рендерер** (T-B2). Это условие
 *    достижимости `matched`: без резолва `assetId → receipt` guard был бы мёртвым кодом, а каждый
 *    ран — вечным `unknown`;
 * 2. **ран против такого эталона идёт как раньше** — `matched`, вердикт по метрикам;
 * 3. **эталон неизвестного происхождения** (PNG, которого сервер не снимал) при включённых
 *    детерминизм-флагах даёт `error/stale_renderer` **без процента** — то есть «переснимите», а не
 *    ложные проценты разницы рендереров.
 *
 * Preview-сервер поднят с `EASYUI_RENDERER_FLAGS=1` (`playwright.config.ts`), поэтому здесь
 * действует пост-флаговая семантика N11 — та же, что будет в проде после §7.
 *
 * Цель — **компонент**, а не экран прототипа: страница плеера в preview-проекте тянет
 * `/api/auth/me` через deny-proxy и приносит консольную ошибку, на которой визуальный ран
 * терминализуется раньше диффа (доволновое поведение, волной не меняется).
 */

const { PNG } = pngjs;
const DS_ID = "e2e-renderer-guard";
const COMPONENT_ID = "e2e-renderer-guard-probe";
const VIEWPORT = { width: 200, height: 120 };

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ caption: z.string().default("guard") }),
  description: "Renderer-guard probe: a fixed-size opaque box, so the frame is byte-stable",
  atomicLevel: "atom" as const,
  examples: { base: { caption: "guard" } },
};

export default function RendererGuardProbe({ props }: EasyUIComponentProps<{ caption: string }>) {
  return <div style={{ width: 128, height: 64, borderRadius: 8, background: "#3355cc" }} data-caption={props.caption} />;
}
`;

interface JobView {
  status: string;
  result?: { assetId?: string; receiptSha256?: string; renderer?: { fingerprint: string }; consoleErrors?: string[]; pageErrors?: string[] };
  error?: { code: string; message: string };
}

interface RunReport {
  status: string;
  diffPercent: number | null;
  metric: string | null;
  outcomeCode: string | null;
  warnings: string[];
  rendererGuard: { state: string; differing: string[]; flags: { rendererFlags: boolean } } | null;
  candidateReceiptSha256: string | null;
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Renderer Guard", description: "Design system for the cross-renderer guard e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: { id: COMPONENT_ID, name: "RendererGuardProbe", source: SOURCE, designSystem: DS_ID, intent: "Однотонная коробка фиксированного размера для проверки cross-renderer guard'а" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const published = await request.post(`/api/components/${COMPONENT_ID}/publish`, { data: { baseRev: 1 } });
  expect(published.status(), await published.text()).toBe(201);
}

async function capture(request: APIRequestContext): Promise<JobView> {
  const post = await request.post(`/api/components/${COMPONENT_ID}/versions/1/screenshot`, {
    data: { viewport: VIEWPORT, deviceScaleFactor: 1, theme: "light" },
  });
  expect(post.status(), await post.text()).toBe(202);
  const { jobId } = await post.json() as { jobId: string };
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await request.get(`/api/screenshot-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const job = await response.json() as JobView;
    if (job.status === "done" || job.status === "error") {
      expect(job.status, `job error: ${job.error?.code ?? ""} ${job.error?.message ?? ""}`).toBe("done");
      return job;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("screenshot job did not settle within 45s");
}

async function reference(request: APIRequestContext, assetId: string) {
  const put = await request.put("/api/visual-references", {
    data: {
      fingerprint: { scope: "component", componentId: COMPONENT_ID, refVersion: 1, viewport: VIEWPORT, deviceScaleFactor: 1, theme: "light" },
      assetId,
    },
  });
  expect(put.status(), await put.text()).toBe(200);
  return await put.json() as { id: string; renderer: { fingerprint: string; epoch: string | null; receiptSha256: string | null } | null };
}

async function runCheck(request: APIRequestContext, referenceId: string): Promise<RunReport> {
  const started = await request.post(`/api/visual-references/${referenceId}/check`, { data: { threshold: 100 } });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = await started.json() as { runId: string };
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await request.get(`/api/visual-runs/${runId}`);
    expect(response.status()).toBe(200);
    const view = await response.json() as RunReport & { status: string };
    if (view.status !== "running") return view;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("visual run did not settle within 120s");
}

test("a server-captured baseline knows its renderer and the check runs as before", async ({ request }) => {
  test.setTimeout(240_000);
  await ensureFixture(request);

  const capabilities = await (await request.get("/api/capabilities")).json() as { renderer?: { fingerprint: string; rendererVersion: string } };
  const job = await capture(request);

  const stored = await reference(request, job.result!.assetId!);
  // T-B2: рендерер эталона резолвит сервер по индексу `assetId → receipt`, а не присылает клиент;
  // он обязан совпасть и с рендерером джобы, и с публикуемым в capabilities.
  expect(stored.renderer, "server-captured baseline carries no renderer").not.toBeNull();
  expect(stored.renderer!.fingerprint).toBe(job.result!.renderer!.fingerprint);
  expect(stored.renderer!.fingerprint).toBe(capabilities.renderer?.fingerprint);
  expect(stored.renderer!.epoch).toBe(capabilities.renderer?.rendererVersion ?? null);
  expect(stored.renderer!.receiptSha256).toBe(job.result!.receiptSha256 ?? null);

  const report = await runCheck(request, stored.id);
  expect(report.rendererGuard?.state, JSON.stringify(report)).toBe("matched");
  expect(report.rendererGuard?.flags.rendererFlags).toBe(true);
  // Guard совпал ⇒ он ничего не решает: ран доигрывается доволновым путём (метрики или, как в
  // preview-проекте, терминализация на консольной ошибке `/api/auth/me` от deny-proxy — это
  // поведение существует до волны и ею не меняется).
  expect(report.outcomeCode).toBeNull();
  expect(report.warnings).toEqual([]);
});

test("a baseline of unknown provenance is refused as stale_renderer instead of being measured", async ({ request }) => {
  test.setTimeout(240_000);
  await ensureFixture(request);

  // PNG, которого сервер никогда не снимал: у ассета нет ссылки на receipt, происхождение кадра
  // неизвестно. Размер намеренно тот же — чтобы отказ нельзя было объяснить габаритами.
  const png = new PNG({ width: VIEWPORT.width, height: VIEWPORT.height });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 12; png.data[i + 1] = 34; png.data[i + 2] = 56; png.data[i + 3] = 255; }
  const upload = await request.post("/api/assets", {
    multipart: { file: { name: "foreign.png", mimeType: "image/png", buffer: PNG.sync.write(png) } },
  });
  expect([200, 201], await upload.text()).toContain(upload.status());
  const foreignId = (await upload.json() as { id: string }).id;

  const stored = await reference(request, foreignId);
  expect(stored.renderer, "a PNG the server never captured must not claim a renderer").toBeNull();

  const report = await runCheck(request, stored.id);
  expect(report.status, JSON.stringify(report)).toBe("error");
  expect(report.outcomeCode).toBe("stale_renderer");
  expect(report.rendererGuard?.state).toBe("unknown");
  // Без процента: сравнивать кадры разных (в том числе неизвестных) рендереров нельзя.
  expect(report.diffPercent).toBeNull();
  expect(report.metric).toBeNull();
  // Кандидат при этом полностью документирован — расследовать есть по чему.
  expect(report.candidateReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
});
