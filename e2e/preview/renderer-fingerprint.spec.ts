import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Renderer fingerprint 2.0 в реальном chromium (план 2026-08-03-renderer-contract-2 §5 R1).
 *
 * Unit-тест доказывает арифметику отпечатка; здесь проверяется то, что от него требуется в бою:
 * - два независимых капчура в одном процессе объявляют **один и тот же** рендерер (иначе ключ
 *   reuse приёмки был бы нестабилен и холодные пересъёмки шли бы на каждый ран);
 * - `GET /api/capabilities` и `GET /api/health` публикуют ровно тот рендерер, которым нарисован
 *   кадр — прод-приёмка §7.1 сверяет эту секцию с `renderer-manifest.json` образа;
 * - отпечаток построен от **фактически запускаемого** бинаря: `launchedExecutable` —
 *   `chrome-headless-shell`, а не `chrome` (C-B1).
 *
 * Спека обязана зеленеть и в **dev-фолбэке** (рабочее дерево, манифеста образа нет): дорогие поля
 * там `null` — это заявленная деградация (T-m16), а не провал. Поэтому проверяется не «поля
 * заполнены», а «объявление согласовано и стабильно»; `source` печатается в лог прогона.
 */

interface RendererReport {
  rendererSchema: number;
  rendererVersion: string;
  fingerprint: string;
  policyHash: string;
  os: string;
  arch: string;
  browserName: string;
  browserVersion: string | null;
  browserRevision: string | null;
  launchedExecutable: string | null;
  browserExecutableSha256: string | null;
  fontStackSha256: string | null;
  appFontsSha256: string | null;
  systemLibsHash: string | null;
  launchDeterminismArgsHash: string;
  contextOptionsHash: string | null;
  colorProfile: string;
  source: "manifest" | "fallback";
  provenance: { buildSha: string | null; imageRef: string | null; builtAt: string | null; bunVersion: string | null } | null;
}

interface JobRenderer {
  rendererVersion: string;
  rendererSchema: number;
  fingerprint: string;
  browserName: string;
  browserVersion: string | null;
  launchedExecutable: string | null;
  browserExecutableSha256: string | null;
  launchDeterminismArgsHash: string;
  colorProfile: string;
  source: "manifest" | "fallback";
}

async function pollJob(request: APIRequestContext, jobId: string) {
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const response = await request.get(`/api/screenshot-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const job = await response.json() as {
      status: string;
      result?: { renderer?: JobRenderer; browserVersion?: string };
      error?: { code: string; message: string };
    };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("screenshot job did not settle within 70s");
}

async function capture(request: APIRequestContext): Promise<{ renderer: JobRenderer; browserVersion: string }> {
  const post = await request.post("/api/prototypes/hello-world/screens/welcome/screenshot", {
    data: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
  });
  expect(post.status(), await post.text()).toBe(202);
  const { jobId } = await post.json() as { jobId: string };
  const job = await pollJob(request, jobId);
  // Расхождение манифеста и образа терминализует джобу кодом `renderer_mismatch` (§3 E2) —
  // если оно случилось, сообщение и есть диагноз, поэтому оно печатается в отказ.
  expect(job.status, `job error: ${job.error?.code ?? ""} ${job.error?.message ?? ""}`).toBe("done");
  expect(job.result?.renderer, "capture result carries no renderer declaration").toBeTruthy();
  return { renderer: job.result!.renderer!, browserVersion: job.result!.browserVersion! };
}

test("two captures declare the same renderer, and it is the renderer capabilities publishes", async ({ request }) => {
  test.setTimeout(240_000);

  const capabilitiesResponse = await request.get("/api/capabilities");
  expect(capabilitiesResponse.status()).toBe(200);
  const { renderer } = await capabilitiesResponse.json() as { renderer: RendererReport };

  console.log(`[renderer] source=${renderer.source} version=${renderer.rendererVersion} browser=${renderer.browserVersion ?? "null"} fingerprint=${renderer.fingerprint}`);
  expect(renderer.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(renderer.policyHash).toMatch(/^[0-9a-f]{64}$/);
  expect(renderer.rendererSchema).toBe(2);
  expect(renderer.colorProfile).toBe("srgb");
  expect(renderer.browserName).toBe("chromium");
  // Рендерит headless-shell; полный chrome кадров не рисует (C-B1). Это обязано быть объявлено.
  expect(renderer.launchedExecutable).toBe("chrome-headless-shell");
  expect(renderer.launchDeterminismArgsHash).toMatch(/^[0-9a-f]{64}$/);
  // Дорогие поля `null` только в dev-фолбэке; в образе манифест обязан их принести.
  if (renderer.source === "manifest") {
    expect(renderer.browserExecutableSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(renderer.browserVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  }

  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  const healthBody = await health.json() as { status: string; renderer?: RendererReport };
  expect(healthBody.renderer?.fingerprint).toBe(renderer.fingerprint);

  const first = await capture(request);
  const second = await capture(request);

  // Главный инвариант волны: отпечаток — функция объявленных входов, а не капчура.
  expect(second.renderer.fingerprint).toBe(first.renderer.fingerprint);
  expect(first.renderer.fingerprint).toBe(renderer.fingerprint);
  expect(first.renderer.rendererVersion).toBe(renderer.rendererVersion);
  expect(first.renderer.source).toBe(renderer.source);
  expect(first.renderer.launchedExecutable).toBe("chrome-headless-shell");
  expect(first.renderer.launchDeterminismArgsHash).toBe(renderer.launchDeterminismArgsHash);

  // Наблюдённая версия браузера прошла сверку major.minor.build с объявленной — иначе джоба
  // терминализовалась бы `renderer_mismatch` ещё в `capture()`.
  expect(second.browserVersion).toBe(first.browserVersion);
  if (renderer.browserVersion !== null) {
    const declared = renderer.browserVersion.split(".").slice(0, 3).join(".");
    expect(first.browserVersion.split(".").slice(0, 3).join(".")).toBe(declared);
  }
});
