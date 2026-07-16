import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCustomComponentCacheForTests, FullDocumentReloadRequiredError, loadCustomComponents, type CustomComponentRef } from "./loader";

const ref = (overrides: Partial<CustomComponentRef> = {}): CustomComponentRef => ({ id: "rating", name: "RatingStars", version: 2, bundleUrl: "/api/components/rating/versions/2/bundle.js", bundleHash: "hash", ...overrides });
const validModule = { definition: { props: z.object({}), description: "Stars" }, default: () => null };

describe("custom component loader", () => {
  beforeEach(clearCustomComponentCacheForTests);

  it("rejects a broken contract with component diagnostics", async () => {
    await expect(loadCustomComponents([ref()], async () => ({ definition: { props: {}, description: "bad" }, default: () => null })))
      .rejects.toThrow("RatingStars v2: definition.props is not a host zod schema");
  });

  it("caches immutable modules by bundle URL", async () => {
    const importer = vi.fn(async () => validModule);
    await loadCustomComponents([ref()], importer);
    await loadCustomComponents([ref()], importer);
    expect(importer).toHaveBeenCalledOnce();
  });

  it("rejects non-/api and absolute URLs before import", async () => {
    const importer = vi.fn(async () => validModule);
    await expect(loadCustomComponents([ref({ bundleUrl: "https://example.com/bundle.js" })], importer)).rejects.toThrow("same-origin /api/");
    expect(importer).not.toHaveBeenCalled();
  });

  it("retries a rejected bundle with a fresh root URL and succeeds", async () => {
    const importer = vi.fn(async (url: string) => {
      if (!url.includes("retry=")) throw new TypeError("Failed to fetch dynamically imported module");
      return validModule;
    });
    await expect(loadCustomComponents([ref()], importer)).resolves.toMatchObject({ components: { RatingStars: expect.any(Function) } });
    expect(importer.mock.calls.map(([url]) => url)).toEqual([
      "/api/components/rating/versions/2/bundle.js",
      "/api/components/rating/versions/2/bundle.js?retry=1",
    ]);
  });

  it("signals full-document reload after the retry fails and performs no further SPA attempts", async () => {
    const importer = vi.fn(async () => { throw new TypeError("module load failed"); });
    await expect(loadCustomComponents([ref()], importer)).rejects.toBeInstanceOf(FullDocumentReloadRequiredError);
    await expect(loadCustomComponents([ref()], importer)).rejects.toBeInstanceOf(FullDocumentReloadRequiredError);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("does not cancel a shared import when one concurrent consumer stops waiting", async () => {
    let resolveImport!: (value: unknown) => void;
    const importer = vi.fn(() => new Promise<unknown>((resolve) => { resolveImport = resolve; }));
    const controller = new AbortController();
    const sharedA = loadCustomComponents([ref()], importer);
    const sharedB = loadCustomComponents([ref()], importer);
    const cancelledA = Promise.race([
      sharedA,
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("consumer aborted")), { once: true })),
    ]);
    controller.abort();
    await expect(cancelledA).rejects.toThrow("consumer aborted");
    resolveImport(validModule);
    await expect(sharedB).resolves.toMatchObject({ definitions: { RatingStars: expect.any(Object) } });
    expect(importer).toHaveBeenCalledOnce();
  });
});
