/**
 * Запуск ink-bbox-воркера (план 2026-08-03 §5 W3). Канон — `server/visual/diff-runner.ts`:
 * node-подпроцесс в своей группе, JSON через stdin/stdout, жёсткий дедлайн с убийством группы.
 *
 * Живёт в `server/acceptance/`, а не в `server/visual/`, по владению файлами (§6: `server/visual/*`
 * — эксклюзив W5a). Один тяжёлый подпроцесс за раз обеспечен самим потоком гейта: ink-bbox
 * считается **после** завершения capture-джобы (§4.6 «один системный слот»).
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const WORKER_PATH = resolve(import.meta.dir, "../../scripts/ink-bbox-worker.mjs");
const INK_DEADLINE_MS = 30_000;

export interface InkBboxRect { x: number; y: number; width: number; height: number }
export interface InkBboxClamp { left: boolean; right: boolean; top: boolean; bottom: boolean }
export type InkBboxOk = {
  ok: true;
  source: "alpha";
  image: { width: number; height: number };
  deviceScaleFactor: number;
  pixelBounds: InkBboxRect | null;
  /** CSS px относительно левого верхнего угла снятой поверхности. */
  bounds: InkBboxRect | null;
  clamped: InkBboxClamp;
};
export type InkBboxErr = { ok: false; error: string };
export type InkBboxResult = InkBboxOk | InkBboxErr;
export interface InkBboxJob { pngBase64: string; options: { deviceScaleFactor: number; alphaThreshold?: number } }
export type RunInkBbox = (job: InkBboxJob) => Promise<InkBboxResult>;

/** Резолв бинаря node: воркер использует pngjs и запускается под node, не под bun. */
function nodeBinary(): string { return process.execPath.includes("bun") ? "node" : process.execPath; }

export const spawnInkBboxWorker: RunInkBbox = (job: InkBboxJob): Promise<InkBboxResult> => {
  return new Promise<InkBboxResult>((resolvePromise) => {
    const child = spawn(nodeBinary(), [WORKER_PATH], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (result: InkBboxResult) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(result); };
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { killGroup(); finish({ ok: false, error: `ink bbox timed out after ${INK_DEADLINE_MS}ms` }); }, INK_DEADLINE_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: `ink bbox worker spawn failed: ${error.message}` }));
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) { finish({ ok: false, error: `ink bbox worker produced no result${stderr ? `: ${stderr.slice(0, 500)}` : ""}` }); return; }
      try { finish(JSON.parse(line) as InkBboxResult); }
      catch { finish({ ok: false, error: `ink bbox worker result was not JSON: ${line.slice(0, 300)}` }); }
    });

    child.stdin.on("error", () => { /* closed before write completes */ });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
};
