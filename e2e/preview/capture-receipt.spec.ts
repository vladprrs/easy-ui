import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Capture receipt на **asset-канале** доставки (план 2026-08-03-renderer-contract-2 §5 R5).
 *
 * Именно этот канал — интерактивный `snap`, кадр визуального рана — до волны не нёс ни рендерера,
 * ни readiness, ни таймингов (дыра §1.6): судить кадр было можно, а знать, чем он нарисован, — нет.
 * Спека проверяет, что теперь по настоящему капчуру в реальном chromium есть машиночитаемый ответ:
 * `receiptSha256` в результате джобы и документ с `renderer`/`resources.fontFaces` по ручке.
 *
 * Ручки «по sha» нет и быть не должно (N12) — доступ только job-scoped.
 */

interface Receipt {
  receiptVersion: number;
  renderer: { fingerprint: string; rendererVersion: string; browserName: string; observedBrowserVersion: string | null; source: string; drift: unknown[] };
  target: { kind: string; prototypeId: string | null; rev: number | null };
  resources: { fontManifestHash: string | null; fontFaces: { family: string; weight: string; style: string; status: string }[]; images: unknown[] };
  console: { errors: string[]; warnings: string[]; pageErrors: string[] };
  output: { pngWidth: number; pngHeight: number; pngSha256: string | null; dpr: number; colorScheme: string; surfaceRect: { width: number; height: number } | null } | null;
  timings: { navigateMs: number | null; totalMs: number | null };
  verdict: { captureClean: boolean; readinessMet: boolean | null; readinessPolicyHash: string | null; codes: unknown[] };
}

async function pollJob(request: APIRequestContext, jobId: string) {
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const response = await request.get(`/api/screenshot-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const job = await response.json() as {
      status: string;
      result?: { assetId?: string; receiptSha256?: string; renderer?: { fingerprint: string } };
      error?: { code: string; message: string };
    };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("screenshot job did not settle within 70s");
}

test("an interactive asset capture carries a receipt, and the job-scoped handle serves it", async ({ request }) => {
  test.setTimeout(180_000);

  const post = await request.post("/api/prototypes/hello-world/screens/welcome/screenshot", {
    data: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
  });
  expect(post.status(), await post.text()).toBe(202);
  const { jobId } = await post.json() as { jobId: string };
  const job = await pollJob(request, jobId);
  expect(job.status, `job error: ${job.error?.code ?? ""} ${job.error?.message ?? ""}`).toBe("done");

  // Asset-доставка: кадр ушёл в asset-store — и всё-таки несёт адрес receipt'а (E4).
  expect(job.result?.assetId).toBeTruthy();
  const receiptSha = job.result?.receiptSha256;
  expect(receiptSha, "asset capture carries no receiptSha256").toMatch(/^[0-9a-f]{64}$/);

  const response = await request.get(`/api/screenshot-jobs/${jobId}/receipt`);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json() as { receiptSha256: string; receipt: Receipt };
  expect(body.receiptSha256).toBe(receiptSha);

  const receipt = body.receipt;
  expect(receipt.receiptVersion).toBe(1);
  // Рендерер receipt'а — тот же, что объявила джоба: доказательство относится к этому кадру.
  expect(receipt.renderer.fingerprint).toBe(job.result?.renderer?.fingerprint);
  expect(receipt.renderer.browserName).toBe("chromium");
  expect(receipt.renderer.observedBrowserVersion).toMatch(/\d+\.\d+\.\d+/);
  expect(receipt.renderer.drift).toEqual([]);
  expect(receipt.target).toMatchObject({ kind: "prototype", prototypeId: "hello-world" });

  // Ресурсы кадра: faces приезжают из доказательства readiness настоящей страницы.
  expect(Array.isArray(receipt.resources.fontFaces)).toBe(true);
  expect(receipt.resources.fontFaces.length).toBeGreaterThan(0);
  for (const face of receipt.resources.fontFaces) {
    expect(typeof face.family).toBe("string");
    expect(typeof face.status).toBe("string");
  }

  // Кадр существует — значит `output` не `null` и опознан по sha (для `probe:"geometry"` он был бы null).
  expect(receipt.output).not.toBeNull();
  expect(receipt.output!.pngSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.output!.pngWidth).toBeGreaterThan(0);
  expect(receipt.output!.surfaceRect?.width).toBeGreaterThan(0);
  expect(receipt.timings.navigateMs).not.toBeNull();
  expect(receipt.timings.totalMs).toBeGreaterThan(0);
  expect(receipt.verdict.readinessPolicyHash).toMatch(/^[0-9a-f]{64}$/);

  // Ручки «по sha» не существует (N12): content-addressed документ не имеет владельца.
  const bySha = await request.get(`/api/capture-receipts/${receiptSha}`);
  expect(bySha.status()).toBe(404);
});
