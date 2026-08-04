import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, test } from "bun:test";
import { buildLaunchArgs, buildDeterminismArgs } from "../scripts/screenshot-worker.mjs";
import { launchKeyOf, POOL_DEFAULTS, poolLimits, recycleReason, treeRssMb } from "../scripts/screenshot-pool-worker.mjs";
import { chromiumAvailable } from "./screenshot/worker-runner";

const POOL_PATH = new URL("../scripts/screenshot-pool-worker.mjs", import.meta.url).pathname;
const STRICT_PATH = new URL("../scripts/screenshot-worker.mjs", import.meta.url).pathname;
const POOL_SOURCE = readFileSync(POOL_PATH, "utf8");
const HAS_CHROMIUM = chromiumAvailable();

/** Handshake, который обязана опубликовать «страница»: точная копия ожидания джобы. */
const EXPECTED = {
  kind: "component", componentId: "pool-probe", version: 1,
  bundleHash: "bundle-hash", propsHash: "props-hash", dsMetaVersion: null, rendererBuild: null,
} as const;

/**
 * Фикстурная «поверхность капчура». Логирует в console.warn то, что видит **до** записи своих
 * следов, затем пачкает контекст (cookie/localStorage) и публикует handshake. Утечка контекста
 * между джобами пула становится наблюдаемой в `consoleWarnings` результата.
 */
function probePage(probe: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>pool probe</title></head><body style="margin:0">
<div id="eui-capture-surface" style="width:120px;height:60px;background:#ffffff"></div>
<script>
(function () {
  var bootstrap = window.__EUI_CAPTURE_BOOTSTRAP__ || {};
  console.warn("probe:" + JSON.stringify({
    cookie: document.cookie,
    ls: window.localStorage.getItem("eui_pool_probe"),
    bootstrapProbe: bootstrap.probe === undefined ? null : bootstrap.probe,
  }));
  document.cookie = "eui_pool_probe=leaked; path=/";
  window.localStorage.setItem("eui_pool_probe", "leaked");
  window.__EUI_CAPTURE_READY__ = ${JSON.stringify({ ...EXPECTED, probe })};
})();
</script></body></html>`;
}

/** Страница, пытающаяся выйти за границу egress: чужой origin и незаявленный путь своего. */
const EGRESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div id="eui-capture-surface" style="width:60px;height:30px;background:#ffffff"></div>
<script>
(async function () {
  var results = {};
  for (const [key, url] of [["external", "http://example.com/steal"], ["unlisted", "/not-allowed"]]) {
    try { const r = await fetch(url); results[key] = "status:" + r.status; }
    catch (error) { results[key] = "blocked"; }
  }
  console.warn("egress:" + JSON.stringify(results));
  window.__EUI_CAPTURE_READY__ = ${JSON.stringify(EXPECTED)};
})();
</script></body></html>`;

interface Fixture { origin: string; server: Server; hits: string[] }

async function startFixture(pages: Record<string, string>): Promise<Fixture> {
  const hits: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.push(path);
    const body = pages[path];
    if (body === undefined) { res.writeHead(404, { "content-type": "text/plain" }); res.end("no"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, server, hits };
}

type Json = Record<string, unknown>;

/** Воркер дописывает к тексту console-сообщения ` (url)` — вырезаем сам JSON-объект. */
function payloadOf(lines: string[] | undefined, prefix: string): Json {
  const line = (lines ?? []).find((item) => item.startsWith(prefix)) ?? "";
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no ${prefix} payload in ${JSON.stringify(lines)}`);
  return JSON.parse(line.slice(start, end + 1)) as Json;
}

function jobFor(fixture: Fixture, url: string, probe: string): Json {
  return {
    captureOrigin: fixture.origin, captureUrl: url, token: "pool-token",
    bootstrap: { kind: "component", target: { id: "pool-probe" }, expected: EXPECTED, probe },
    allowedUrls: [url], viewport: { width: 200, height: 120 }, deviceScaleFactor: 1,
    colorScheme: "light", waitForFonts: false, expected: EXPECTED,
    determinismArgs: buildDeterminismArgs(true),
  };
}

/** Живой клиент пула: NDJSON по stdin/stdout, ответы разбираются по `id`. */
class PoolProcess {
  private readonly child = spawn(process.execPath.includes("bun") ? "node" : process.execPath, [POOL_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  private readonly waiting = new Map<string, (message: Json) => void>();
  readonly stderr: string[] = [];
  private seq = 0;

  constructor() {
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (line.trim().length === 0) return;
      const message = JSON.parse(line) as Json;
      if (message.type !== "result") return;
      const waiter = this.waiting.get(String(message.id));
      this.waiting.delete(String(message.id));
      waiter?.(message);
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString()));
  }

  run(job: Json): Promise<{ result: Json; pool: Json }> {
    const id = `t-${(this.seq += 1)}`;
    return new Promise((done) => {
      this.waiting.set(id, (message) => done({ result: message.result as Json, pool: message.pool as Json }));
      this.child.stdin.write(`${JSON.stringify({ type: "job", id, job })}\n`);
    });
  }

  stop(): void { try { this.child.kill("SIGKILL"); } catch { /* gone */ } }
}

/** Один прогон strict-воркера (процесс на джобу) — эталон байтов для сверки с пулом. */
function runStrict(job: Json): Promise<Json> {
  return new Promise((done) => {
    const child = spawn(process.execPath.includes("bun") ? "node" : process.execPath, [STRICT_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", () => {
      const line = out.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
      done(JSON.parse(line) as Json);
    });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}

const open: { pools: PoolProcess[]; fixtures: Fixture[] } = { pools: [], fixtures: [] };
const track = <T extends PoolProcess | Fixture>(item: T): T => {
  if (item instanceof PoolProcess) open.pools.push(item); else open.fixtures.push(item as Fixture);
  return item;
};

afterEach(async () => {
  for (const pool of open.pools.splice(0)) pool.stop();
  for (const fixture of open.fixtures.splice(0)) await new Promise<void>((done) => fixture.server.close(() => done()));
});

describe("screenshot pool worker (план §5 R9a)", () => {
  test("recycle policy is exact: origin change, failed job, job budget, TTL, RSS", () => {
    const limits = { maxJobs: 20, ttlMs: 60_000, rssLimitMb: 1500 };
    const base = { browserAlive: true, launchKey: "A", jobs: 1, startedAt: 1000, rssMb: 100, lastJobOk: true };
    expect(recycleReason(base, limits, 2000)).toBeNull();
    expect(recycleReason({ ...base, browserAlive: false, jobs: 99 }, limits, 10 ** 9)).toBeNull();
    expect(recycleReason({ ...base, requestedKey: "B" }, limits, 2000)).toBe("origin_changed");
    expect(recycleReason({ ...base, requestedKey: "A" }, limits, 2000)).toBeNull();
    expect(recycleReason({ ...base, lastJobOk: false }, limits, 2000)).toBe("job_failed");
    expect(recycleReason({ ...base, jobs: 20 }, limits, 2000)).toBe("job_budget");
    expect(recycleReason(base, limits, 61_000)).toBe("ttl");
    expect(recycleReason({ ...base, rssMb: 1500 }, limits, 2000)).toBe("rss");
    // Порог RSS не участвует, когда /proc недоступен: null — «неизвестно», а не «превышено».
    expect(recycleReason({ ...base, rssMb: null }, limits, 2000)).toBeNull();
  });

  test("pool limits come from env with the documented defaults", () => {
    expect(POOL_DEFAULTS).toEqual({ maxJobs: 20, ttlMs: 10 * 60_000, rssLimitMb: 1500 });
    expect(poolLimits({})).toEqual({ ...POOL_DEFAULTS });
    expect(poolLimits({ EASYUI_POOL_MAX_JOBS: "3", EASYUI_POOL_TTL_MS: "5000", EASYUI_POOL_RSS_MB: "700" }))
      .toEqual({ maxJobs: 3, ttlMs: 5000, rssLimitMb: 700 });
    expect(poolLimits({ EASYUI_POOL_MAX_JOBS: "nonsense" }).maxJobs).toBe(POOL_DEFAULTS.maxJobs);
  });

  test("launch key covers exactly what launch args freeze: capture origin and determinism args", () => {
    const a = { captureOrigin: "http://127.0.0.1:4173", determinismArgs: buildDeterminismArgs(true) };
    expect(launchKeyOf(a)).toBe(launchKeyOf({ ...a }));
    expect(launchKeyOf(a)).not.toBe(launchKeyOf({ ...a, captureOrigin: "http://127.0.0.1:8787" }));
    expect(launchKeyOf(a)).not.toBe(launchKeyOf({ ...a, determinismArgs: buildDeterminismArgs(false) }));
  });

  test("tree RSS is a number on linux and never throws", async () => {
    const mb = await treeRssMb();
    expect(mb === null || mb > 0).toBe(true);
  });

  /**
   * Граница egress в пуле — дословно та же, что у strict-воркера: пул не имеет права иметь
   * собственный список аргументов запуска или собственный матчер allowlist.
   */
  test("egress boundary is imported verbatim from the strict worker, not re-implemented", () => {
    expect(POOL_SOURCE).toContain('from "./screenshot-worker.mjs"');
    expect(POOL_SOURCE).toContain("buildLaunchArgs(denyPort, capturePort)");
    expect(POOL_SOURCE).toContain("matchAllowed(path, job.allowedUrls)");
    expect(POOL_SOURCE).toContain('"x-easyui-capture": job.token');
    expect(POOL_SOURCE).toContain('serviceWorkers: "block"');
    expect(POOL_SOURCE).toContain("routeWebSocket");
    // Ни одного собственного launch-аргумента: список — только импортируемый.
    expect(POOL_SOURCE).not.toContain("--proxy-server");
    expect(POOL_SOURCE).not.toContain("--host-resolver-rules");
    // Детерминизм-args — только из payload джобы (T-m17), как и у strict-воркера.
    expect(POOL_SOURCE).not.toContain("EASYUI_RENDERER_FLAGS");
    expect(POOL_SOURCE).toContain("job.determinismArgs");
    // Контекст закрывается всегда: это единственная граница изоляции джоб.
    expect(POOL_SOURCE).toContain("context?.close()");
    // Дословный набор egress-аргументов (тот же ассерт, что в strict-тесте — здесь он фиксирует,
    // что пул запускает браузер именно этим списком).
    expect(buildLaunchArgs(41111, "4173")).toEqual([
      "--proxy-server=http://127.0.0.1:41111",
      "--proxy-bypass-list=<-loopback>;127.0.0.1:4173",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--disable-quic",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy",
    ]);
  });

  test.skipIf(!HAS_CHROMIUM)("context does not leak between pool jobs: cookies, localStorage, bootstrap", async () => {
    const fixture = track(await startFixture({ "/first": probePage("first"), "/second": probePage("second") }));
    const pool = track(new PoolProcess());

    const first = await pool.run(jobFor(fixture, "/first", "first"));
    expect(first.result.ok).toBe(true);
    const second = await pool.run(jobFor(fixture, "/second", "second"));
    expect(second.result.ok).toBe(true);

    const seenOf = (result: Json) => payloadOf(result.consoleWarnings as string[], "probe:");

    expect(seenOf(first.result)).toEqual({ cookie: "", ls: null, bootstrapProbe: "first" });
    // Вторая джоба того же браузера обязана видеть чистый лист — и свой собственный бутстрап.
    expect(seenOf(second.result)).toEqual({ cookie: "", ls: null, bootstrapProbe: "second" });
    // Браузер при этом переиспользован: ресайкла между джобами не было.
    expect(second.pool.launched).toBe(false);
    expect(second.pool.recycledBefore).toBeNull();
    expect(second.pool.jobs).toBe(2);
  }, 120_000);

  test.skipIf(!HAS_CHROMIUM)("egress boundary holds inside the pool: foreign origin and unlisted path are aborted", async () => {
    const fixture = track(await startFixture({ "/egress": EGRESS_PAGE, "/not-allowed": "<html>secret</html>" }));
    const pool = track(new PoolProcess());
    const { result } = await pool.run(jobFor(fixture, "/egress", "egress"));
    expect(result.ok).toBe(true);
    expect(payloadOf(result.consoleWarnings as string[], "egress:")).toEqual({ external: "blocked", unlisted: "blocked" });
    // Незаявленный путь не доехал даже до фикстурного сервера: route-allowlist рубит запрос
    // в браузере, а не полагается на сервер.
    expect(fixture.hits).toEqual(["/egress"]);
  }, 120_000);

  test.skipIf(!HAS_CHROMIUM)("pool frames are byte-identical to the strict worker's", async () => {
    const fixture = track(await startFixture({ "/first": probePage("first") }));
    const job = jobFor(fixture, "/first", "first");
    const strict = await runStrict(job);
    const pool = track(new PoolProcess());
    const first = await pool.run(job);
    const second = await pool.run(job);
    expect(strict.ok).toBe(true);
    expect(first.result.pngSha256).toBe(strict.pngSha256 as string);
    // И между джобами одного браузера кадр тоже не дрейфует (K1 внутри пула).
    expect(second.result.pngSha256).toBe(strict.pngSha256 as string);
  }, 180_000);

  test.skipIf(!HAS_CHROMIUM)("a failed job always recycles the browser, and a new origin relaunches it", async () => {
    const alpha = track(await startFixture({ "/first": probePage("first") }));
    const beta = track(await startFixture({ "/first": probePage("first") }));
    const pool = track(new PoolProcess());

    // Быстрый отказ: путь не в allowlist ⇒ навигацию рубит route-allowlist, а не таймаут.
    const missing = await pool.run({ ...jobFor(alpha, "/first", "missing"), allowedUrls: [] });
    expect(missing.result.ok).toBe(false);
    expect(missing.result.code).toBe("navigation_failed");
    // Не-ok исход обязан ресайклить браузер: следующая джоба стартует с чистого процесса.
    expect(missing.pool.recycledAfter).toBe("job_failed");

    const good = await pool.run(jobFor(alpha, "/first", "first"));
    expect(good.result.ok).toBe(true);
    expect(good.pool.launched).toBe(true);

    const other = await pool.run(jobFor(beta, "/first", "first"));
    expect(other.result.ok).toBe(true);
    expect(other.pool.recycledBefore).toBe("origin_changed");
    expect(other.pool.launched).toBe(true);
  }, 180_000);
});
