/**
 * T-m20 (R6): cross-renderer сверка при reuse acceptance-результатов. Три тихих режима функции —
 * прозой в плане, здесь — тестами: отсутствие receipt.json терпимо (kill-switch), нечитаемый
 * артефакт и дрейф отпечатка ⇒ пересъёмка (false), совпадение ⇒ reuse (true).
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reusableRendererMatches } from "./runner";
import { putArtifact } from "./evidence";
import { rendererFingerprint } from "../capture/renderer";
import { readinessPolicyHashOf } from "./ids";
import { ACCEPTANCE_POLICIES } from "./policies";

const policy = ACCEPTANCE_POLICIES["default-v1"]!;
let dataDir: string;

beforeAll(async () => { dataDir = await mkdtemp(join(tmpdir(), "r6-reuse-")); });
afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });

const depsOf = () => ({ context: { dataDir }, policy } as unknown as Parameters<typeof reusableRendererMatches>[0]);

describe("reusableRendererMatches (T-m20)", () => {
  it("без receipt.json reuse разрешён (kill-switch receipts не наказывается пересъёмкой)", async () => {
    expect(await reusableRendererMatches(depsOf(), [{ name: "frame.png", sha256: "0".repeat(64), bytes: 1 }])).toBe(true);
  });

  it("нечитаемый артефакт receipt.json ⇒ пересъёмка (false), не ошибка рана", async () => {
    expect(await reusableRendererMatches(depsOf(), [{ name: "receipt.json", sha256: "1".repeat(64), bytes: 1 }])).toBe(false);
  });

  it("битый JSON внутри receipt.json ⇒ пересъёмка (false)", async () => {
    const artifact = await putArtifact(dataDir, "{not json");
    expect(await reusableRendererMatches(depsOf(), [{ name: "receipt.json", sha256: artifact.sha256, bytes: artifact.bytes }])).toBe(false);
  });

  it("совпадающий отпечаток ⇒ reuse (true); дрейф ⇒ пересъёмка (false)", async () => {
    const current = rendererFingerprint(readinessPolicyHashOf(policy.readiness));
    const match = await putArtifact(dataDir, { renderer: { fingerprint: current } });
    expect(await reusableRendererMatches(depsOf(), [{ name: "receipt.json", sha256: match.sha256, bytes: match.bytes }])).toBe(true);
    const drifted = await putArtifact(dataDir, { renderer: { fingerprint: "f".repeat(64) } });
    expect(await reusableRendererMatches(depsOf(), [{ name: "receipt.json", sha256: drifted.sha256, bytes: drifted.bytes }])).toBe(false);
  });

  it("receipt без renderer.fingerprint (билд до R5) ⇒ reuse разрешён", async () => {
    const artifact = await putArtifact(dataDir, { renderer: {} });
    expect(await reusableRendererMatches(depsOf(), [{ name: "receipt.json", sha256: artifact.sha256, bytes: artifact.bytes }])).toBe(true);
  });
});
