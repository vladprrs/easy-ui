import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";
import type { RunJob, WorkerJob, WorkerResult } from "./service";

const WORKER_PATH = resolve(import.meta.dir, "../../scripts/screenshot-worker.mjs");

/** Resolves the node binary; the worker must run under node (playwright), not bun. */
function nodeBinary(): string { return process.execPath.includes("bun") ? "node" : process.execPath; }

/**
 * Production {@link RunJob}: spawns the node screenshot worker in its own
 * process group, streams the job as JSON over stdin, parses the single JSON
 * result from stdout, and kills the whole group on the hard deadline.
 */
export const spawnWorker: RunJob = (job: WorkerJob, deadlineMs: number): Promise<WorkerResult> => {
  return new Promise<WorkerResult>((resolvePromise) => {
    const child = spawn(nodeBinary(), [WORKER_PATH], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (result: WorkerResult) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(result); };
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { killGroup(); finish({ ok: false, error: `capture timed out after ${deadlineMs}ms` }); }, deadlineMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: `worker spawn failed: ${error.message}` }));
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) { finish({ ok: false, error: `worker produced no result${stderr ? `: ${stderr.slice(0, 500)}` : ""}` }); return; }
      try { finish(JSON.parse(line) as WorkerResult); }
      catch { finish({ ok: false, error: `worker result was not JSON: ${line.slice(0, 300)}` }); }
    });

    child.stdin.on("error", () => { /* closed before write completes */ });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
};

/** True when a playwright chromium build is resolvable in this environment. */
export function chromiumAvailable(): boolean {
  try { const path = chromium.executablePath(); return typeof path === "string" && path.length > 0; }
  catch { return false; }
}
