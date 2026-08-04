import { spawn } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Типизированные коды капчура в реальном chromium
 * (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 **E3**, §5 **R3**, метрика K4).
 *
 * Unit-тесты проверяют словарь и маппинг; здесь проверяется то, чего они не могут:
 *
 * 1. **`navigation_failed` — не текст ошибки, а код.** Воркер запускается на несуществующем
 *    адресе (закрытый порт loopback'а): `page.goto` отказывает по-настоящему, и воркер обязан
 *    вернуть `code: "navigation_failed"` — именно то значение, которое `ScreenshotService`
 *    кладёт в `failure.code` джобы (сверка маппинга — `server/screenshot.test.ts`).
 *    Через HTTP такой кадр не поставить: capture-URL собирает сервер, клиент на него не влияет —
 *    поэтому фикстура работает с воркером напрямую, но с настоящим браузером.
 * 2. **Аддитивные поля ручки джобы.** Успешная съёмка отдаёт `outcome: "ok"` и не выдумывает
 *    `failure`; доволновые `status`/`result` остаются на месте.
 *
 * Живёт в `e2e/preview/`: только preview-проект поднимает `SERVE_DIST` (без него капчур — 501).
 */

const WORKER = "scripts/screenshot-worker.mjs";

/** Один прогон воркера: JSON в stdin, одна JSON-строка в stdout (контракт `emitResult`). */
async function runWorker(job: Record<string, unknown>): Promise<{ ok: boolean; code?: string; error?: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("node", [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      try { resolve(JSON.parse(stdout.trim().split("\n").pop() ?? "")); }
      catch (error) { reject(new Error(`worker result was not JSON: ${stdout || stderr} (${String(error)})`)); }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

test("несуществующий URL даёт типизированный navigation_failed, а не безымянный capture_failed", async () => {
  // Порт 1 на loopback'е закрыт: соединение отвергается сразу, без ожидания таймаута навигации.
  const captureOrigin = "http://127.0.0.1:1";
  const result = await runWorker({
    captureOrigin,
    captureUrl: "/capture/component/does-not-exist/1",
    token: "e2e-token",
    allowedUrls: ["/capture/"],
    viewport: { width: 320, height: 240 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    waitForFonts: false,
    determinismArgs: [],
    bootstrap: {
      kind: "component",
      target: {},
      expected: { kind: "component", componentId: "does-not-exist", version: 1, bundleHash: "b", propsHash: "p", dsMetaVersion: null, rendererBuild: null },
    },
    expected: { kind: "component", componentId: "does-not-exist", version: 1, bundleHash: "b", propsHash: "p", dsMetaVersion: null, rendererBuild: null },
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("navigation_failed");
  // Сообщение остаётся человекочитаемым — код его дополняет, а не заменяет.
  expect(result.error).toContain("navigation failed");
});

test("успешная джоба отдаёт аддитивный outcome и не выдумывает failure", async ({ request }) => {
  const job = await captureFirstPrototypeScreen(request);
  expect(job.status, `job error: ${job.error?.code ?? ""} ${job.error?.message ?? ""}`).toBe("done");
  expect(job.outcome).toBe("ok");
  expect(job.failure).toBeUndefined();
  expect(job.result?.kind).toBe("image");
});

interface JobBody {
  status: string;
  result?: { kind?: string };
  error?: { code: string; message: string };
  outcome?: string;
  failure?: { code: string; message: string };
}

/** Снимает известный preview-прототип `hello-world` — предмет теста не картинка, а форма ответа. */
async function captureFirstPrototypeScreen(request: APIRequestContext): Promise<JobBody> {
  const enqueued = await request.post("/api/prototypes/hello-world/screens/welcome/screenshot", {
    data: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
  });
  expect(enqueued.status()).toBe(202);
  const { jobId } = await enqueued.json() as { jobId: string };

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request.get(`/api/screenshot-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const body = await response.json() as JobBody;
    if (body.status === "done" || body.status === "error") return body;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("screenshot job did not settle");
}
