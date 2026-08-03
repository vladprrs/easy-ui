import { describe, expect, it } from "vitest";
import type { PrototypeDraft } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";
import { documentDesignSystems, pinDesignSystems, prototypeRuntimeKey } from "./PrototypeLoader";

const plain = prototypeDocSchema.parse({
  version: 1, id: "plain", name: "Plain", designSystem: "shadcn", device: "mobile", startScreen: "home", state: {},
  screens: [{ id: "home", name: "Дом", spec: { root: "t", elements: { t: { type: "Text", props: { text: "Дом" } } } } }],
});

const duo = prototypeDocSchema.parse({
  version: 1, id: "duo", name: "Дуо", designSystem: "kiosk", device: "desktop", startScreen: "kso", state: {},
  surfaces: [
    { id: "kso", name: "КСО", device: "desktop", startScreen: "kso" },
    { id: "app", name: "Приложение", device: "mobile", designSystem: "pay-two", startScreen: "app" },
  ],
  screens: [
    { id: "kso", name: "Касса", surface: "kso", canvas: { width: 1080, height: 1920 }, spec: { root: "t", elements: { t: { type: "Text", props: { text: "Касса" } } } } },
    { id: "app", name: "Дом", surface: "app", spec: { root: "t", elements: { t: { type: "Text", props: { text: "Дом" } } } } },
  ],
});

const draft = (doc: typeof plain): PrototypeDraft => ({ doc, rev: 5, builtinCatalogHash: "b", componentManifestHash: "manifest", components: [] });

describe("документные дизайн-системы и runtimeKey (multi-surface D8)", () => {
  it("документ без surfaces даёт единственную ДС и прежний ключ", () => {
    expect(documentDesignSystems(plain)).toEqual(["shadcn"]);
    expect(prototypeRuntimeKey(draft(plain))).toBe("plain:r5:manifest:shadcn");
  });

  it("дуо-док несёт ДС обеих поверхностей: смена любой из них пересоздаёт сессию", () => {
    expect(documentDesignSystems(duo)).toEqual(["kiosk", "pay-two"]);
    expect(prototypeRuntimeKey(draft(duo))).toBe("duo:r5:manifest:kiosk+pay-two");
    const switched = { ...duo, surfaces: [duo.surfaces![0]!, { ...duo.surfaces![1]!, designSystem: "pay-three" }] };
    expect(prototypeRuntimeKey(draft(switched))).not.toBe(prototypeRuntimeKey(draft(duo)));
  });

  it("одна и та же ДС на обеих поверхностях не дублируется в ключе", () => {
    const same = { ...duo, surfaces: duo.surfaces!.map((surface) => ({ ...surface, designSystem: undefined })) };
    expect(documentDesignSystems(same)).toEqual(["kiosk"]);
  });

  it("карта `имя → ДС` строится только по пинам, которые её несут", () => {
    expect(pinDesignSystems([
      { id: "a", name: "KsoTile", version: 1, bundleUrl: "/a", bundleHash: "h", designSystem: "kiosk" },
      { id: "b", name: "AppCard", version: 1, bundleUrl: "/b", bundleHash: "h" },
    ])).toEqual({ KsoTile: "kiosk" });
  });
});
