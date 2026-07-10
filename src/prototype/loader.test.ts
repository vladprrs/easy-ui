import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrototypeDraft } from "../api/client";
import { InvalidPrototypeResponseError, loadPrototypeDraft } from "./loader";

vi.mock("../api/client", () => ({
  getPrototypeDraft: vi.fn(), getPrototypeVersion: vi.fn(), listPrototypes: vi.fn(),
}));

describe("prototype loader", () => {
  beforeEach(() => vi.mocked(getPrototypeDraft).mockReset());

  it("rejects an invalid API document with a typed error", async () => {
    vi.mocked(getPrototypeDraft).mockResolvedValue({
      doc: { id: "broken" }, rev: 1, builtinCatalogHash: "hash", componentManifestHash: "hash", components: [],
    } as never);
    await expect(loadPrototypeDraft("broken")).rejects.toBeInstanceOf(InvalidPrototypeResponseError);
  });
});
