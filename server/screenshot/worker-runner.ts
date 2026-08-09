import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";
import type { RunJob, WorkerJob, WorkerResult } from "./service";
import { ALLOCATE_DEADLINE_MS } from "./sessions";

const WORKER_PATH = resolve(import.meta.dir, "../../scripts/screenshot-worker.mjs");
const POOL_WORKER_PATH = resolve(import.meta.dir, "../../scripts/screenshot-pool-worker.mjs");

/** Resolves the node binary; the worker must run under node (playwright), not bun. */
function nodeBinary(): string { return process.execPath.includes("bun") ? "node" : process.execPath; }

/**
 * Веха аллокации в NDJSON-потоке воркера (BR-06). Отличается от результата по построению:
 * результат всегда несёт булев `ok`, веха — только `type`.
 */
export const isAllocatedMilestone = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; ok?: unknown };
    return parsed !== null && typeof parsed === "object" && parsed.type === "allocated" && parsed.ok === undefined;
  } catch { return false; }
};

/**
 * Последняя строка потока, которая **является результатом** (BR-06). До волны бралась просто
 * последняя непустая строка; с появлением вехи это уже неверно у воркера, умершего после
 * аллокации: последней строкой стала бы веха, и `{"type":"allocated"}` разобрался бы как «результат
 * без `ok`». Отбор по наличию `ok` — тот же контракт, что у `WorkerResult`.
 */
export function resultLineOf(stdout: string): string | undefined {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (isAllocatedMilestone(line)) continue;
    return line;
  }
  return undefined;
}

/**
 * Production {@link RunJob}: spawns the node screenshot worker in its own
 * process group, streams the job as JSON over stdin, parses the single JSON
 * result from stdout, and kills the whole group on the hard deadline.
 *
 * **Шов `allocate-renderer` (BR-06, план 2026-08-08 §6).** Дедлайн делится надвое: до вехи
 * `{"type":"allocated"}` действует {@link ALLOCATE_DEADLINE_MS}, после — переданный `deadlineMs`,
 * отсчитываемый заново. Смысл раскола в том, что «браузер не достался» и «съёмка не уложилась» —
 * разные отказы с разной ценой: первый терминален и виден приёмке как `allocate_timeout`, второй
 * ретраится как обычный `timeout`. Сообщения обеих ветвей дословно распознаёт `classifyJobFailure`.
 */
export const spawnPerJobWorker: RunJob = (job: WorkerJob, deadlineMs: number): Promise<WorkerResult> => {
  return new Promise<WorkerResult>((resolvePromise) => {
    const child = spawn(nodeBinary(), [WORKER_PATH], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = ""; let stderr = ""; let settled = false; let allocated = false; let pending = "";
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: WorkerResult) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(result); };
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    timer = setTimeout(
      () => { killGroup(); finish({ ok: false, error: `renderer allocation timed out after ${ALLOCATE_DEADLINE_MS}ms` }); },
      ALLOCATE_DEADLINE_MS,
    );
    /** Веха увидена: дедлайн аллокации снимается, job-дедлайн стартует с нуля. */
    const onAllocated = (): void => {
      if (allocated || settled) return;
      allocated = true;
      clearTimeout(timer);
      timer = setTimeout(() => { killGroup(); finish({ ok: false, error: `capture timed out after ${deadlineMs}ms` }); }, deadlineMs);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (allocated) return;
      // Веха ищется построчно и только до её прихода: результат может быть в мегабайты base64,
      // и сканировать их на каждом чанке было бы дороже самой съёмки.
      pending += chunk;
      for (;;) {
        const index = pending.indexOf("\n");
        if (index === -1) break;
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line.length > 0 && isAllocatedMilestone(line)) { onAllocated(); return; }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: `worker spawn failed: ${error.message}` }));
    child.on("close", () => {
      const line = resultLineOf(stdout);
      if (!line) { finish({ ok: false, error: `worker produced no result${stderr ? `: ${stderr.slice(0, 500)}` : ""}` }); return; }
      try { finish(JSON.parse(line) as WorkerResult); }
      catch { finish({ ok: false, error: `worker result was not JSON: ${line.slice(0, 300)}` }); }
    });

    child.stdin.on("error", () => { /* closed before write completes */ });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
};

/** Статистика пула, приезжающая рядом с результатом джобы (для замера `measure-capture.mjs`). */
export interface PoolJobStats {
  jobs: number; recycles: number; rssMb: number | null; browserAgeMs: number;
  launched: boolean; recycledBefore: string | null; recycledAfter: string | null; lastRecycleReason: string | null;
}

/**
 * Клиент тёплого пула (план §5 **R9a**): один долгоживущий node-процесс на весь сервер,
 * NDJSON по stdin/stdout, ответы разбираются по `id` джобы.
 *
 * Живучесть — не «best effort», а часть контракта `RunJob`: смерть процесса, дедлайн и
 * нечитаемая строка обязаны давать обычный `{ok:false}`, а не висящий промис. Дедлайн бьёт по
 * **всей группе процессов** (как у per-job воркера) — иначе осиротевший chromium пережил бы
 * таймаут и продолжил жрать CPU.
 */
class PoolClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<string, {
    settle: (result: WorkerResult, stats: PoolJobStats | null) => void;
    /** BR-06: пул подтвердил аллокацию браузера под эту джобу. */
    allocated: () => void;
  }>();
  /** Статистика последней завершённой джобы — читается замером, в результат джобы не течёт. */
  lastStats: PoolJobStats | null = null;

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child !== null) return this.child;
    const child = spawn(nodeBinary(), [POOL_WORKER_PATH], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child = child;
    this.buffer = "";
    // Все обработчики привязаны к **этому** процессу: события убитого пула приходят уже после
    // того, как поднят новый, и не имеют права ни осиротить его, ни отказать его джобам.
    const alive = () => this.child === child;
    child.stdout.on("data", (chunk: Buffer) => { if (alive()) this.consume(chunk.toString()); });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[pool] ${chunk.toString()}`));
    child.on("error", (error) => { if (alive()) this.fail(`pool worker spawn failed: ${error.message}`); });
    child.on("close", (code) => { if (alive()) this.fail(`pool worker exited with code ${code ?? "null"}`); });
    child.stdin.on("error", () => { /* closed under us; the close handler settles the callers */ });
    return child;
  }

  /** Разбор NDJSON-потока: строки могут приходить кусками и склеенными. */
  private consume(text: string): void {
    this.buffer += text;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message: { type?: string; id?: string; result?: WorkerResult; pool?: PoolJobStats | null; error?: string };
      try { message = JSON.parse(line); }
      catch { process.stderr.write(`[pool] non-JSON line: ${line.slice(0, 200)}\n`); continue; }
      // BR-06: веха аллокации адресная (`id` джобы) — у пула ожидающих может быть несколько,
      // и «браузер достался» относится ровно к той джобе, которую пул взял в работу.
      if (message.type === "allocated" && typeof message.id === "string") {
        this.pending.get(message.id)?.allocated();
        continue;
      }
      if (message.type === "result" && typeof message.id === "string") {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        waiter?.settle(message.result ?? { ok: false, error: "pool worker returned no result" }, message.pool ?? null);
        continue;
      }
      if (message.type === "fatal") process.stderr.write(`[pool] fatal: ${message.error ?? "unknown"}\n`);
    }
  }

  /** Процесс умер (или не родился): все ожидающие получают честный отказ, пул пересоздаётся. */
  private fail(reason: string): void {
    this.child = null;
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) waiter.settle({ ok: false, error: reason }, null);
  }

  /** Есть ли живой процесс пула (BR-06: спавн — часть фазы аллокации). */
  alive(): boolean { return this.child !== null; }

  private killGroup(): void {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }

  /**
   * ИНВАРИАНТ (приёмка R9a): дедлайн заводится в момент вызова и включает ожидание в очереди
   * пула. При конкуренции capture = 1 (сегодняшний сервис) это эквивалентно per-job семантике;
   * при появлении ручки конкуренции таймаут джобы из очереди убьёт killGroup'ом ВЕСЬ пул вместе
   * с чужим идущим капчуром — дедлайн тогда обязан стартовать при фактическом начале исполнения.
   *
   * **Шов `allocate-renderer` (BR-06).** У пула фаза аллокации — это `ensure()` (спавн процесса,
   * если он умер) плюс `acquire()` внутри воркера (ресайкл/`chromium.launch`), и у неё свой
   * дедлайн {@link ALLOCATE_DEADLINE_MS}. Job-дедлайн стартует только после адресной вехи
   * `{"type":"allocated", id}`: до волны холодный старт пула съедал минуту капчура, и «браузер
   * поднимался 40 s» выглядело как «съёмка не уложилась».
   */
  run(job: WorkerJob, deadlineMs: number): Promise<WorkerResult> {
    return new Promise<WorkerResult>((resolvePromise) => {
      const child = this.ensure();
      const id = `job-${(this.seq += 1)}`;
      let settled = false;
      let allocated = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (result: WorkerResult, stats: PoolJobStats | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stats !== null) this.lastStats = stats;
        resolvePromise(result);
      };
      const expire = (message: string) => {
        this.pending.delete(id);
        // Дедлайн в пуле — событие процесса, а не джобы: браузер остался в неизвестном
        // состоянии, поэтому убивается вся группа, а следующая джоба поднимает пул заново.
        this.killGroup();
        this.fail(message);
        settle({ ok: false, error: message }, null);
      };
      timer = setTimeout(() => expire(`renderer allocation timed out after ${ALLOCATE_DEADLINE_MS}ms`), ALLOCATE_DEADLINE_MS);
      const onAllocated = () => {
        if (allocated || settled) return;
        allocated = true;
        clearTimeout(timer);
        timer = setTimeout(() => expire(`capture timed out after ${deadlineMs}ms`), deadlineMs);
      };
      this.pending.set(id, { settle, allocated: onAllocated });
      child.stdin.write(`${JSON.stringify({ type: "job", id, job })}\n`);
    });
  }

  /** Остановка пула — для тестов и для аккуратного завершения процесса. */
  stop(): void { this.killGroup(); this.fail("pool worker stopped"); }
}

const poolClient = new PoolClient();

/** Включён ли тёплый пул (`EASYUI_RENDERER_POOL=1`); читается на каждой джобе — флаг флипается. */
export const poolEnabled = (): boolean => process.env.EASYUI_RENDERER_POOL === "1";

/** Прямой доступ к пулу: замер (`scripts/measure-capture.mjs` через API) и тесты. */
export const poolRunJob: RunJob = (job: WorkerJob, deadlineMs: number): Promise<WorkerResult> => poolClient.run(job, deadlineMs);
export const poolStats = (): PoolJobStats | null => poolClient.lastStats;
export const stopPool = (): void => poolClient.stop();

/**
 * Прод-`RunJob`. Имя сохранено (`server/main.ts` — чужая зона владения, §6): выбор имплемента
 * делает сама функция по `EASYUI_RENDERER_POOL`, а не точка сборки.
 */
export const spawnWorker: RunJob = (job: WorkerJob, deadlineMs: number): Promise<WorkerResult> =>
  (poolEnabled() ? poolRunJob : spawnPerJobWorker)(job, deadlineMs);

/** True when a playwright chromium build is resolvable in this environment. */
export function chromiumAvailable(): boolean {
  try { const path = chromium.executablePath(); return typeof path === "string" && path.length > 0; }
  catch { return false; }
}
