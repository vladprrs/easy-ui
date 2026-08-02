import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

// Фикстурные тесты харнесного compare.mjs (план 2026-08-02 agent-iteration DX, P3).
// Канон движка живёт в share/yp-figma-rebuild-skill/ (см. §4 плана, топология харнеса);
// зеркал у него нет, поэтому тест ходит прямо в канон. PNG генерируются программно —
// бинарных фикстур в репозитории не появляется.

const compare = resolve("share/yp-figma-rebuild-skill/compare.mjs");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(process.cwd(), ".compare-cli-test-"));
  directories.push(directory);
  return directory;
}

/** Сплошной холст `fill`, поверх которого закрашиваются прямоугольники `boxes`. */
async function writePng(path: string, width: number, height: number, boxes: { x: number; y: number; width: number; height: number; color: [number, number, number] }[] = [], fill: [number, number, number] = [255, 255, 255]) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const box = boxes.find((item) => x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height);
      const [r, g, b] = box ? box.color : fill;
      const index = (y * width + x) * 4;
      png.data[index] = r; png.data[index + 1] = g; png.data[index + 2] = b; png.data[index + 3] = 255;
    }
  }
  await Bun.write(path, PNG.sync.write(png));
}

async function run(args: string[]) {
  const child = Bun.spawn({ cmd: ["node", compare, ...args], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("harness compare.mjs", () => {
  test("reports clusters, the AA diagnostic and leaves the raw reference untouched", async () => {
    const directory = await testDirectory();
    const reference = resolve(directory, "ref.png");
    const candidate = resolve(directory, "cand.png");
    const diff = resolve(directory, "diff.png");
    // Два несмежных пятна: 12x3 @ (208,41) и 2x2 @ (4,4).
    await writePng(reference, 320, 60);
    await writePng(candidate, 320, 60, [
      { x: 208, y: 41, width: 12, height: 3, color: [0, 0, 0] },
      { x: 4, y: 4, width: 2, height: 2, color: [0, 0, 0] },
    ]);
    const before = readFileSync(reference);

    const result = await run([reference, candidate, diff]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("40/19200 px differ = 0.21% (threshold 0.1)");
    expect(result.stdout).toContain("AA-diagnostic (threshold 0.25): 40/19200 px = 0.21%");
    expect(result.stdout).toContain("clusters: 2");
    expect(result.stdout).toContain("cluster 12x3 px @ (208,41) — 36 px differ");
    expect(result.stdout).toContain("cluster 2x2 px @ (4,4) — 4 px differ");
    expect(await Bun.file(diff).exists()).toBe(true);
    // Raw-эталон не мутируется: единственный записываемый файл — diff.png.
    expect(readFileSync(reference).equals(before)).toBe(true);
    expect(readFileSync(candidate).length).toBeGreaterThan(0);
  });

  test("a size mismatch prints a dimension report and still diffs the overlapping area", async () => {
    const directory = await testDirectory();
    const reference = resolve(directory, "ref.png");
    const candidate = resolve(directory, "cand.png");
    await writePng(reference, 328, 58);
    await writePng(candidate, 328, 56, [{ x: 0, y: 0, width: 4, height: 4, color: [0, 0, 0] }]);

    const result = await run([reference, candidate]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("size mismatch: candidate 328x56 vs ref 328x58 (dw 0, dh -2)");
    expect(result.stdout).toContain("comparing the overlapping 328x56 area");
    expect(result.stdout).toContain("16/18368 px differ");
    expect(result.stdout).toContain("cluster 4x4 px @ (0,0) — 16 px differ");
  });

  test("--region scopes the diff and its optional budget decides the exit code", async () => {
    const directory = await testDirectory();
    const reference = resolve(directory, "ref.png");
    const candidate = resolve(directory, "cand.png");
    await writePng(reference, 100, 100);
    await writePng(candidate, 100, 100, [{ x: 10, y: 10, width: 10, height: 10, color: [0, 0, 0] }]);

    const clean = await run([reference, candidate, "--region", "50,50,20,20", "--region", "0,0,40,40:15"]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain("region 50,50,20,20: 0/400 px = 0.00%");
    expect(clean.stdout).toContain("region 0,0,40,40:15: 100/1600 px = 6.25% (budget 15% — ok)");

    const exceeded = await run([reference, candidate, "--region", "0,0,40,40:5"]);
    expect(exceeded.exitCode).toBe(1);
    expect(exceeded.stdout).toContain("(budget 5% — EXCEEDED)");

    const machine = await run([reference, candidate, "--region", "10,10,10,10", "--json"]);
    expect(machine.exitCode).toBe(0);
    const payload = JSON.parse(machine.stdout) as { mismatched: number; clusters: unknown[]; regions: { percent: number }[]; exitCode: number };
    expect(payload).toMatchObject({ mismatched: 100, exitCode: 0 });
    expect(payload.clusters).toHaveLength(1);
    expect(payload.regions[0]!.percent).toBe(100);
  });

  test("usage and flag errors exit 2 without writing anything", async () => {
    const directory = await testDirectory();
    const reference = resolve(directory, "ref.png");
    await writePng(reference, 10, 10);
    expect((await run([reference])).exitCode).toBe(2);
    expect((await run([reference, reference, "--region", "1,2,3"])).stderr).toContain("--region must be x,y,w,h");
    expect((await run([reference, reference, "--threshold", "9"])).stderr).toContain("--threshold must be a number from 0 to 1");
    expect((await run([reference, reference, "--nope"])).stderr).toContain("unknown flag: --nope");
    const missing = await run([resolve(directory, "absent.png"), reference]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("cannot read PNG");
  });
});
