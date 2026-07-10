import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCustomComponentCacheForTests, loadCustomComponents, type CustomComponentRef } from "./loader";

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
});
