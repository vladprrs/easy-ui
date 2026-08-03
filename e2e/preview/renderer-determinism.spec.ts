import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Детерминизм капчура в реальном chromium (план `docs/plans/2026-08-03-renderer-contract-2.md`
 * §5 **R2b**, метрика K1).
 *
 * Полный корпус — 12 фикстур × 20 вариантов = 240 капчуров — гоняет `scripts/renderer-corpus.mjs`
 * (`npm run corpus:verify`, гейт CI перед деплоем, §5 R2c): в e2e он не помещается по времени.
 * Здесь проверяется то, что обязано держаться на каждом прогоне `npm run e2e`:
 *
 * 1. **K1 в малом.** Один и тот же объявленный вход (компонент, версия, props, вьюпорт, DPR,
 *    тема) дважды подряд даёт **байт-идентичный** PNG, а смена DPR даёт другой растр — то есть
 *    capture является функцией входов, а не истории процесса. Байтовая идентичность проверяется
 *    честным sha256 скачанных байтов, а не только дедупликацией asset-стора.
 * 2. **Текущее (до R4) поведение подмножества `outcome/`.** Отсутствующий шрифтовой ассет,
 *    битое изображение и поздняя мутация layout сегодня **не валят** капчур и не приносят
 *    типизированного кода (§1.4–1.5: `settleFonts` не смотрит на `FontFace.status`,
 *    `settleImages` валит только полное отсутствие растра, `settleFrames` не перемеряет).
 *    Это зафиксировано намеренно: R3/R4 вводят `CaptureFailureCode`, и **владелец R4** меняет
 *    эти ожидания вместе с `e2e/fixtures/renderer-corpus/outcome/**` (§6).
 * 3. **Арифметика гейта и версия эталонов.** `corpus.json` описывает ровно 12×20=240 капчуров,
 *    а `expected.json` записан для того же `RENDERER_VERSION`, который объявляет сервер
 *    (§6: sha-часть меняется только с bump'ом версии рендерера).
 *
 * Живёт в `e2e/preview/`: только preview-проект поднимает `SERVE_DIST` (без него капчур — 501)
 * и включает `EASYUI_RENDERER_FLAGS=1` (`playwright.config.ts`, R2a) — ту же конфигурацию
 * рендерера, что меряет корпус.
 */

const CORPUS_DIR = "e2e/fixtures/renderer-corpus";
const DS_ID = "renderer-corpus";

interface CorpusManifest {
  fixtures: { id: string; subset: "pixel" | "outcome"; name: string; source: string; props: Record<string, unknown>; intent: string }[];
  variants: { id: string; theme: string; dsf: number; viewport: { width: number; height: number }; truncated?: boolean }[];
  assets: Record<string, { file: string; mime: string; placeholder?: string; repoRoot?: boolean }>;
}

interface ImageResult {
  assetId: string; width: number; height: number; imageProduced: boolean;
  consoleErrors: string[]; pageErrors: string[];
}

// Синхронное чтение на уровне модуля: top-level await недоступен в транспилированной спеке.
const manifest = JSON.parse(readFileSync(`${CORPUS_DIR}/corpus.json`, "utf8")) as CorpusManifest;
const expected = JSON.parse(readFileSync(`${CORPUS_DIR}/expected.json`, "utf8")) as { rendererVersion: string; pixel: Record<string, Record<string, string>>; outcome: Record<string, Record<string, unknown>> };

const fixture = (id: string) => {
  const found = manifest.fixtures.find((item) => item.id === id);
  if (!found) throw new Error(`corpus fixture ${id} is missing from corpus.json`);
  return found;
};
const variant = (id: string) => {
  const found = manifest.variants.find((item) => item.id === id);
  if (!found) throw new Error(`corpus variant ${id} is missing from corpus.json`);
  return found;
};

async function expectOk(step: string, response: { status(): number; text(): Promise<string> }, allowed: number[]) {
  if (allowed.includes(response.status())) return;
  throw new Error(`${step}: HTTP ${response.status()} ${await response.text()}`);
}

/**
 * Публикует фикстуры корпуса; `__ASSET_PNG__` резолвится живым ассетом.
 *
 * **Каждая фикстура — в своей ДС.** Preview-сервер держит гейт переиспользования в `enforce`, а
 * фикстуры корпуса намеренно однотипны по сигнатуре пропсов (`{caption}`) — вторая в той же ДС
 * получила бы `409 component_reuse_required`. Тот же приём в `capture-readiness.spec.ts`.
 * Полный harness (`scripts/renderer-corpus.mjs`) держит все 12 в одной ДС и гасит гейт
 * `REUSE_GATE=shadow`: он меряет рендерер, а не каталожную политику.
 */
async function provision(request: APIRequestContext, ids: string[]): Promise<void> {
  const png = await request.post("/api/assets", {
    data: await readFile(`${CORPUS_DIR}/${manifest.assets.png.file}`),
    headers: { "content-type": manifest.assets.png.mime },
  });
  await expectOk("upload raster asset", png, [200, 201]);
  const pngId = (await png.json() as { id: string }).id;

  for (const id of ids) {
    const item = fixture(id);
    const designSystem = `${DS_ID}-${item.id}`;
    const ds = await request.post("/api/design-systems", {
      data: { id: designSystem, name: `Renderer Corpus ${item.id}`, description: `Renderer corpus fixture ${item.id} (plan R2b)` },
    });
    await expectOk(`create design system ${designSystem}`, ds, [201, 409]);
    const source = (await readFile(`${CORPUS_DIR}/${item.source}`, "utf8")).replaceAll("__ASSET_PNG__", pngId);
    const created = await request.post("/api/components", {
      data: { id: item.id, name: item.name, source, designSystem, intent: item.intent },
    });
    await expectOk(`create component ${item.id}`, created, [201]);
    const published = await request.post(`/api/components/${item.id}/publish`, { data: { baseRev: 1 } });
    await expectOk(`publish component ${item.id}`, published, [201]);
  }
}

async function capture(request: APIRequestContext, fixtureId: string, variantId: string): Promise<{ status: string; result?: ImageResult; error?: { code: string; message: string } }> {
  const item = fixture(fixtureId);
  const shot = variant(variantId);
  const post = await request.post(`/api/components/${item.id}/versions/1/screenshot`, {
    data: { props: item.props, viewport: shot.viewport, deviceScaleFactor: shot.dsf, theme: shot.theme },
  });
  await expectOk(`enqueue ${fixtureId}/${variantId}`, post, [202]);
  const { jobId } = await post.json() as { jobId: string };
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await request.get(`/api/screenshot-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const job = await response.json() as { status: string; result?: ImageResult; error?: { code: string; message: string } };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`screenshot job ${jobId} did not settle within 45s`);
}

async function pngSha(request: APIRequestContext, assetId: string): Promise<string> {
  const response = await request.get(`/api/assets/${assetId}`);
  expect(response.status()).toBe(200);
  return createHash("sha256").update(await response.body()).digest("hex");
}

const OUTCOME_IDS = ["corpus-missing-font-asset", "corpus-broken-image", "corpus-late-layout-mutation"];

test.beforeAll(async ({ request }) => {
  await provision(request, ["corpus-text-ys", ...OUTCOME_IDS]);
});

test("the corpus gate is the declared 12×20 matrix and its expectations belong to this renderer", async ({ request }) => {
  expect(manifest.fixtures).toHaveLength(12);
  expect(manifest.fixtures.filter((item) => item.subset === "pixel")).toHaveLength(9);
  expect(manifest.fixtures.filter((item) => item.subset === "outcome")).toHaveLength(3);
  expect(manifest.variants).toHaveLength(20);
  // Усечённая матрица PR-CI (§4): 12×3.
  expect(manifest.variants.filter((item) => item.truncated === true)).toHaveLength(3);
  expect(manifest.fixtures.length * manifest.variants.length).toBe(240);

  // sha-часть `expected.json` действительна только для объявленного рендерера (§6).
  const capabilities = await request.get("/api/capabilities");
  expect(capabilities.status()).toBe(200);
  const { renderer } = await capabilities.json() as { renderer: { rendererVersion: string } };
  expect(expected.rendererVersion).toBe(renderer.rendererVersion);
  for (const item of manifest.fixtures.filter((entry) => entry.subset === "pixel")) {
    expect(Object.keys(expected.pixel[item.id] ?? {}), `${item.id} has no recorded expectations`).toHaveLength(20);
  }
  for (const id of OUTCOME_IDS) {
    expect(Object.keys(expected.outcome[id] ?? {}), `${id} has no recorded outcomes`).toHaveLength(20);
  }
});

test("K1: repeating one declared input reproduces the PNG byte for byte, and DPR changes it", async ({ request }) => {
  test.setTimeout(180_000);

  const first = await capture(request, "corpus-text-ys", "l-1-390x844");
  const second = await capture(request, "corpus-text-ys", "l-1-390x844");
  expect(first.status, `job error: ${first.error?.code ?? ""} ${first.error?.message ?? ""}`).toBe("done");
  expect(second.status).toBe("done");

  const firstSha = await pngSha(request, first.result!.assetId);
  const secondSha = await pngSha(request, second.result!.assetId);
  // Байты, а не только id: дедупликация asset-стора не должна быть единственным доказательством.
  expect(secondSha).toBe(firstSha);
  expect(second.result!.assetId).toBe(first.result!.assetId);
  expect(first.result!.imageProduced).toBe(true);

  // Тот же вход при другом DPR обязан дать другой растр — иначе «идентичность» ничего не значит.
  const scaled = await capture(request, "corpus-text-ys", "d-2-390x844");
  expect(scaled.status).toBe("done");
  expect(await pngSha(request, scaled.result!.assetId)).not.toBe(firstSha);
  expect(scaled.result!.width).toBe(first.result!.width * 2);
});

test("outcome fixtures still pass through the untyped capture path (expectations move with R4)", async ({ request }) => {
  test.setTimeout(180_000);

  for (const id of OUTCOME_IDS) {
    const job = await capture(request, id, "l-1-390x844");
    // Текущее поведение (§1.4): ни один из трёх дефектов не терминализует капчур и не приносит
    // типизированного кода. R3 вводит `failure.code`, R4 — строгую readiness; тогда эти три
    // ожидания меняются на `font_face_missing` / `image_load_failed` / `layout_unstable` (K3/K4).
    expect(job.status, `${id} unexpectedly terminalized: ${job.error?.code ?? ""}`).toBe("done");
    expect(job.error).toBeUndefined();
    expect(job.result!.imageProduced).toBe(true);
    expect((job.result as unknown as { failure?: unknown }).failure).toBeUndefined();

    const recorded = expected.outcome[id]?.["l-1-390x844"] as { status: string; imageProduced: boolean } | undefined;
    expect(recorded, `${id} is missing from expected.json`).toBeTruthy();
    expect(recorded!.status).toBe("done");
    expect(recorded!.imageProduced).toBe(true);
  }
});
