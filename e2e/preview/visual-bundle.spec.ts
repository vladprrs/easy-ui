import { expect, test, type APIRequestContext } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import { createHash } from "node:crypto";

/**
 * Diagnostic bundle визуального рана против реального Bun preview-сервера
 * (план 2026-08-03-renderer-contract-2 §5 **R7b**, P1.5).
 *
 * Спека проверяет ровно то, ради чего архив существует: расследование одного рана обязано быть
 * **одним GET'ом** и **самопроверяемым**. Поэтому здесь настоящий конвейер — реальный chromium
 * снимает эталон и кандидата, сервер судит ран, — а утверждения касаются архива:
 *
 * 1. в нём лежат оба кадра, обе производные маски, оба receipt'а, отчёт и `SHA256SUMS`;
 * 2. каждая строка `SHA256SUMS` сходится с байтами файла (иначе архив не доказательство);
 * 3. `report.json` называет происхождение каждого файла и несёт отчёт того же рана;
 * 4. несуществующий ран — `404`, а не пустой архив (отказ `409 bundle_not_ready` у бегущего рана
 *    покрыт unit-тестом `server/visual-bundle.test.ts`: ловить гонку старта рана в e2e значило бы
 *    писать флаки-спеку).
 *
 * **Про `diff-perceptual.png` в preview-проекте.** Визуальный ран здесь терминализуется на
 * консольной ошибке `/api/auth/me` (SPA-шелл капчур-страницы дёргает её, deny-proxy её не
 * пропускает) — доволновое поведение, зафиксированное и в `renderer-guard.spec.ts`. Такой ран
 * diff-ассета не производит вовсе, поэтому спека проверяет **контракт честности**: файла нет, а
 * `report.json` называет причину. Полный девятифайловый архив (с diff-ассетом настоящего
 * измеренного рана) покрыт unit-тестом `server/visual-bundle.test.ts`.
 */

const DS_ID = "e2e-visual-bundle";
const COMPONENT_ID = "e2e-visual-bundle-probe";
const VIEWPORT = { width: 200, height: 120 };

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ caption: z.string().default("bundle") }),
  description: "Diagnostic-bundle probe: a fixed-size opaque box, so the frame is byte-stable",
  atomicLevel: "atom" as const,
  examples: { base: { caption: "bundle" } },
};

export default function VisualBundleProbe({ props }: EasyUIComponentProps<{ caption: string }>) {
  return <div style={{ width: 128, height: 64, borderRadius: 8, background: "#2a7f62" }} data-caption={props.caption} />;
}
`;

interface JobView {
  status: string;
  result?: { assetId?: string; receiptSha256?: string };
  error?: { code: string; message: string };
}

interface RunReport {
  runId: string; status: string; outcomeCode: string | null;
  reference: { assetId: string } | null; candidate: { assetId: string } | null; diff: { assetId: string } | null;
  candidateReceiptSha256: string | null; referenceReceiptSha256: string | null;
}

interface BundleReport {
  bundleVersion: number; runId: string; status: string;
  run: RunReport;
  receipts: Record<string, { sha256: string; present: boolean; reason?: string } | null>;
  artifacts: { name: string; present: boolean; sha256?: string; bytes?: number; source?: string; reason?: string }[];
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Visual Bundle", description: "Design system for the visual diagnostic bundle e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: { id: COMPONENT_ID, name: "VisualBundleProbe", source: SOURCE, designSystem: DS_ID, intent: "Однотонная коробка фиксированного размера для проверки diagnostic bundle визуального рана" },
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
    const job = await (await request.get(`/api/screenshot-jobs/${jobId}`)).json() as JobView;
    if (job.status === "done" || job.status === "error") {
      expect(job.status, `job error: ${job.error?.code ?? ""} ${job.error?.message ?? ""}`).toBe("done");
      return job;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("screenshot job did not settle within 45s");
}

async function startCheck(request: APIRequestContext, referenceId: string): Promise<string> {
  const started = await request.post(`/api/visual-references/${referenceId}/check`, { data: { threshold: 100 } });
  expect(started.status(), await started.text()).toBe(202);
  return (await started.json() as { runId: string }).runId;
}

async function awaitRun(request: APIRequestContext, runId: string): Promise<RunReport> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const view = await (await request.get(`/api/visual-runs/${runId}`)).json() as RunReport;
    if (view.status !== "running") return view;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("visual run did not settle within 120s");
}

test("the bundle of one visual run carries every artifact with matching sha256", async ({ request }) => {
  test.setTimeout(240_000);
  await ensureFixture(request);

  // Эталон — кадр серверного капчура: только у такого эталона есть receipt (R5/R6), поэтому
  // архив может доказывать происхождение **обеих** сторон сравнения, а не одной.
  const job = await capture(request);
  const put = await request.put("/api/visual-references", {
    data: {
      fingerprint: { scope: "component", componentId: COMPONENT_ID, refVersion: 1, viewport: VIEWPORT, deviceScaleFactor: 1, theme: "light" },
      assetId: job.result!.assetId!,
      receiptSha256: job.result!.receiptSha256,
    },
  });
  expect(put.status(), await put.text()).toBe(200);
  const referenceId = (await put.json() as { id: string }).id;

  const runId = await startCheck(request, referenceId);
  const report = await awaitRun(request, runId);
  expect(report.status, JSON.stringify(report)).not.toBe("running");
  expect(report.candidate, JSON.stringify(report)).not.toBeNull();

  const response = await request.get(`/api/visual-runs/${runId}/bundle.zip`);
  expect(response.status(), await response.text()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/zip");
  const files = unzipSync(new Uint8Array(await response.body()));
  const expected = [
    "SHA256SUMS", "candidate-receipt.json", "candidate.png", "diff-exact.png",
    "edge-mask.png", "reference-receipt.json", "reference.png", "report.json",
  ];
  if (report.diff !== null) expected.push("diff-perceptual.png");
  expect(Object.keys(files).sort()).toEqual(expected.sort());

  // Самопроверяемость: `sha256sum -c SHA256SUMS` снаружи обязан сходиться на каждой строке.
  const sums = strFromU8(files.SHA256SUMS!).trim().split("\n");
  expect(sums).toHaveLength(Object.keys(files).length - 1);
  for (const line of sums) {
    const [sha, name] = line.split("  ");
    expect(files[name!], `SHA256SUMS lists ${name}, which is absent from the archive`).toBeDefined();
    expect(createHash("sha256").update(Buffer.from(files[name!]!)).digest("hex"), name).toBe(sha);
  }

  const bundle = JSON.parse(strFromU8(files["report.json"]!)) as BundleReport;
  expect(bundle.bundleVersion).toBe(1);
  expect(bundle.runId).toBe(runId);
  expect(bundle.run.status).toBe(report.status);
  // Оба receipt'а — настоящие документы конвейера, а не заглушки.
  expect(bundle.receipts["reference-receipt.json"]).toMatchObject({ present: true });
  expect(bundle.receipts["candidate-receipt.json"]).toMatchObject({ present: true });
  expect(JSON.parse(strFromU8(files["reference-receipt.json"]!))).toMatchObject({ receiptVersion: 1 });
  // Происхождение каждого файла названо: кадры — ассеты рана, маски — пересчитаны на запросе.
  const sources = Object.fromEntries(bundle.artifacts.filter((item) => item.present).map((item) => [item.name, item.source!]));
  expect(sources["reference.png"]).toBe(`asset:${report.reference!.assetId}`);
  expect(sources["candidate.png"]).toBe(`asset:${report.candidate!.assetId}`);
  if (report.diff !== null) expect(sources["diff-perceptual.png"]).toBe(`asset:${report.diff.assetId}`);
  else expect(bundle.artifacts.find((item) => item.name === "diff-perceptual.png")).toMatchObject({ present: false, reason: "asset_not_recorded" });
  expect(sources["diff-exact.png"]).toBe("derived:exact-rgba");
  expect(sources["edge-mask.png"]).toBe("derived:sobel-edge-mask");

  // Воспроизводимость: фиксированный mtime + детерминированное содержимое ⇒ те же байты.
  const again = new Uint8Array(await (await request.get(`/api/visual-runs/${runId}/bundle.zip`)).body());
  expect(createHash("sha256").update(Buffer.from(again)).digest("hex"))
    .toBe(createHash("sha256").update(Buffer.from(await response.body())).digest("hex"));

  // Несуществующий ран — 404, а не пустой архив.
  expect((await request.get("/api/visual-runs/vrun_missing/bundle.zip")).status()).toBe(404);
});
