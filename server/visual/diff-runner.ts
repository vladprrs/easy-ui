import { spawn } from "node:child_process";
import { resolve } from "node:path";

const WORKER_PATH = resolve(import.meta.dir, "../../scripts/visual-diff-worker.mjs");

export interface DiffJob {
  referencePngBase64: string;
  candidatePngBase64: string;
  options: { threshold: number; includeAA: boolean };
}
export type DiffOk = {
  ok: true;
  dimensionMismatch: boolean;
  refDims: { width: number; height: number };
  candDims: { width: number; height: number };
  exact?: { diffPixels: number; totalPixels: number };
  pixelmatch?: { diffPixels: number; totalPixels: number; options: { threshold: number; includeAA: boolean } };
  diffPngBase64?: string;
};
export type DiffErr = { ok: false; error: string };
export type DiffResult = DiffOk | DiffErr;
export type RunDiff = (job: DiffJob) => Promise<DiffResult>;

const DIFF_DEADLINE_MS = 30_000;

/** Resolves the node binary; the diff worker uses node (pngjs/pixelmatch), not bun. */
function nodeBinary(): string { return process.execPath.includes("bun") ? "node" : process.execPath; }

/**
 * Production {@link RunDiff}: spawns the node visual-diff worker in its own
 * process group, streams the job as JSON over stdin, parses the single JSON
 * result line, and kills the group on a hard deadline.
 */
export const spawnDiffWorker: RunDiff = (job: DiffJob): Promise<DiffResult> => {
  return new Promise<DiffResult>((resolvePromise) => {
    const child = spawn(nodeBinary(), [WORKER_PATH], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (result: DiffResult) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(result); };
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { killGroup(); finish({ ok: false, error: `visual diff timed out after ${DIFF_DEADLINE_MS}ms` }); }, DIFF_DEADLINE_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: `diff worker spawn failed: ${error.message}` }));
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) { finish({ ok: false, error: `diff worker produced no result${stderr ? `: ${stderr.slice(0, 500)}` : ""}` }); return; }
      try { finish(JSON.parse(line) as DiffResult); }
      catch { finish({ ok: false, error: `diff worker result was not JSON: ${line.slice(0, 300)}` }); }
    });

    child.stdin.on("error", () => { /* closed before write completes */ });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
};
