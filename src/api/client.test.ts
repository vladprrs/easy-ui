import { beforeEach, describe, expect, it, vi } from "vitest";
import { savePrototype, type FigmaProvenance } from "./client";
import { prototypeDocSchema } from "../prototype/schema";

const doc = prototypeDocSchema.parse({
  version: 1, id: "figma-demo", name: "Figma demo", device: "mobile", startScreen: "home", state: {},
  screens: [{ id: "home", name: "Home", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Hi" } } } } }],
});
const figma: FigmaProvenance = { fileKey: "abcDEF123", nodeIds: ["1:2", "3:4"], lastSyncedAt: "2026-07-13T00:00:00.000Z" };
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

describe("savePrototype figma pass-through (WF-5)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => ok({ rev: 2, warnings: [] }))));

  it("sends the provided figma provenance in the PUT payload", async () => {
    await savePrototype("figma-demo", doc, 1, figma, "keep provenance");
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.figma).toEqual(figma);
    expect(body.baseRev).toBe(1);
    expect(body.message).toBe("keep provenance");
  });

  it("omits the figma field entirely for null (never sends figma: null)", async () => {
    await savePrototype("figma-demo", doc, 1, null);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect("figma" in body).toBe(false);
  });
});
