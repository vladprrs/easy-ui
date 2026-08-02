import { describe, expect, it } from "vitest";
import {
  SURFACES_LIMIT,
  SURFACE_DESIGN_SYSTEM_UNSUPPORTED_CODE,
  inputPrototypeDocSchema,
  storedPrototypeDocSchema,
} from "../schema";
import { docSurfaces, primarySurface, resolveStepCompanions, screensOfSurface, surfaceDesignSystem, surfaceOf } from "../surfaces";

// План docs/plans/2026-08-02-multi-surface-flows.md, W1: D1–D5 (формат и валидация).

const spec = (id: string) => ({ root: "root", elements: { root: { type: "Text", props: { text: id } } } });
const screen = (id: string, surface?: string, canvas?: { width: number; height: number }) => ({
  id,
  name: id,
  ...(surface === undefined ? {} : { surface }),
  ...(canvas === undefined ? {} : { canvas }),
  spec: spec(id),
});

const kso = { id: "kso", name: "КСО", device: "desktop" as const, startScreen: "kso-idle" };
const app = { id: "app", name: "Приложение", device: "mobile" as const, startScreen: "app-home" };

/** Валидный дуо-документ: primary = desktop-КСО (экраны с canvas), вторая поверхность — mobile. */
function duo(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "duo",
    name: "Duo",
    designSystem: "shadcn",
    device: "desktop",
    startScreen: "kso-idle",
    state: {},
    surfaces: [kso, app],
    screens: [
      screen("kso-idle", "kso", { width: 1080, height: 1920 }),
      screen("kso-pay", "kso", { width: 1080, height: 1920 }),
      screen("app-home", "app"),
      screen("app-receipt", "app"),
    ],
    ...overrides,
  };
}

const issues = (value: unknown) => {
  const result = inputPrototypeDocSchema.safeParse(value);
  return result.success ? [] : result.error.issues;
};
const messages = (value: unknown) => issues(value).map((entry) => `${entry.path.join("/")}: ${entry.message}`);
const has = (value: unknown, path: string, message: string) =>
  issues(value).some((entry) => entry.path.join("/") === path && entry.message === message);

describe("surfaces schema — positive (D1–D5)", () => {
  it("accepts a valid duo document in both branches", () => {
    expect(messages(duo())).toEqual([]);
    expect(storedPrototypeDocSchema.safeParse(duo()).success).toBe(true);
  });

  it("accepts companions pointing at the other surface", () => {
    const doc = duo({
      flows: [{
        id: "main",
        name: "main",
        steps: [
          { screenId: "kso-idle", companions: { app: "app-home" } },
          { screenId: "kso-pay", note: "оплата на кассе", companions: { app: "app-receipt" } },
        ],
      }],
    });
    expect(messages(doc)).toEqual([]);
  });

  it("keeps documents without surfaces byte-for-byte valid", () => {
    const plain = {
      version: 1, id: "plain", name: "Plain", designSystem: "shadcn", startScreen: "a", state: {},
      screens: [screen("a"), screen("b")],
    };
    expect(messages(plain)).toEqual([]);
    const parsed = inputPrototypeDocSchema.parse(plain);
    expect(parsed.surfaces).toBeUndefined();
    expect(parsed.screens[0]!.surface).toBeUndefined();
  });
});

describe("surfaces schema — D1 (limits, unique ids)", () => {
  it("requires at least two surfaces and rejects more than SURFACES_LIMIT", () => {
    expect(issues(duo({ surfaces: [kso] })).length).toBeGreaterThan(0);
    const third = { id: "till", name: "Касса", device: "tablet" as const, startScreen: "kso-idle" };
    expect(issues(duo({ surfaces: [kso, app, third] })).some((entry) => entry.path.join("/") === "surfaces")).toBe(true);
    expect(SURFACES_LIMIT).toBe(2);
  });

  it("enforces unique surface ids", () => {
    expect(has(duo({ surfaces: [kso, { ...app, id: "kso" }] }), "surfaces/1/id", "surface id must be unique")).toBe(true);
  });

  it("rejects an unknown surface field and an over-long name", () => {
    expect(issues(duo({ surfaces: [{ ...kso, extra: 1 }, app] })).length).toBeGreaterThan(0);
    expect(issues(duo({ surfaces: [{ ...kso, name: "x".repeat(61) }, app] })).length).toBeGreaterThan(0);
  });
});

describe("surfaces schema — D2/D2a (screen membership)", () => {
  it("requires every screen to declare an existing surface", () => {
    const missing = duo({ screens: [screen("kso-idle", undefined, { width: 10, height: 10 }), screen("app-home", "app")] });
    expect(has(missing, "screens/0/surface", "screen must declare a surface when the document defines surfaces")).toBe(true);
    const foreign = duo({ screens: [screen("kso-idle", "nope", { width: 10, height: 10 }), screen("app-home", "app")] });
    expect(has(foreign, "screens/0/surface", "screen surface must reference an existing surface")).toBe(true);
  });

  it("rejects screen.surface on a document without surfaces", () => {
    const plain = {
      version: 1, id: "plain", name: "Plain", designSystem: "shadcn", startScreen: "a", state: {},
      screens: [screen("a", "kso"), screen("b")],
    };
    expect(has(plain, "screens/0/surface", "screen surface requires the document to define surfaces")).toBe(true);
    // Та же проверка обязана работать и в stored-ветке (D4: референциальная целостность в обеих).
    expect(storedPrototypeDocSchema.safeParse(plain).success).toBe(false);
  });

  it("requires canvas on every screen of a desktop surface (D2a)", () => {
    const noCanvas = duo({ screens: [screen("kso-idle", "kso"), screen("app-home", "app")] });
    expect(has(noCanvas, "screens/0/canvas", "screen of a desktop surface must declare a canvas")).toBe(true);
    // Mobile-поверхность canvas не требует.
    expect(has(duo(), "screens/2/canvas", "screen of a desktop surface must declare a canvas")).toBe(false);
  });
});

describe("surfaces schema — D3 (primary invariants)", () => {
  it("requires doc.startScreen and doc.device to equal the primary surface", () => {
    expect(has(duo({ startScreen: "app-home" }), "startScreen", "startScreen must equal the startScreen of the primary surface (surfaces[0])")).toBe(true);
    expect(has(duo({ device: "mobile" }), "device", "device must equal the device of the primary surface (surfaces[0])")).toBe(true);
    // Опущенный `device` резолвится дефолтом `desktop` — с desktop-primary это валидно.
    expect(messages(duo({ device: undefined }))).toEqual([]);
  });

  it("requires every surface startScreen to belong to that surface", () => {
    const doc = duo({ surfaces: [kso, { ...app, startScreen: "kso-pay" }] });
    expect(has(doc, "surfaces/1/startScreen", "surface startScreen must reference a screen of this surface")).toBe(true);
  });
});

describe("surfaces schema — D5 (companions)", () => {
  const withCompanions = (companions: Record<string, string>) => duo({
    flows: [{ id: "main", name: "main", steps: [{ screenId: "kso-idle", companions }, { screenId: "kso-pay" }] }],
  });

  it("rejects companions on the step's own surface", () => {
    expect(has(withCompanions({ kso: "kso-pay" }), "flows/0/steps/0/companions/kso", "companion surface must differ from the surface of the step screen")).toBe(true);
  });

  it("rejects an unknown surface, an unknown screen and a foreign screen", () => {
    expect(has(withCompanions({ nope: "app-home" }), "flows/0/steps/0/companions/nope", "companion surface must reference an existing surface")).toBe(true);
    expect(has(withCompanions({ app: "missing" }), "flows/0/steps/0/companions/app", "companion screen must reference an existing screen")).toBe(true);
    expect(has(withCompanions({ app: "kso-pay" }), "flows/0/steps/0/companions/app", "companion screen must belong to the companion surface")).toBe(true);
  });

  it("rejects companions on a document without surfaces (both branches)", () => {
    const plain = {
      version: 1, id: "plain", name: "Plain", designSystem: "shadcn", startScreen: "a", state: {},
      screens: [screen("a"), screen("b")],
      flows: [{ id: "main", name: "main", steps: [{ screenId: "a", companions: { app: "b" } }, { screenId: "b" }] }],
    };
    expect(has(plain, "flows/0/steps/0/companions/app", "step companions require the document to define surfaces")).toBe(true);
    expect(storedPrototypeDocSchema.safeParse(plain).success).toBe(false);
  });
});

describe("surfaces schema — W1 per-surface design systems", () => {
  it("accepts a surface design system equal to the document one and rejects a different one", () => {
    expect(messages(duo({ surfaces: [{ ...kso, designSystem: "shadcn" }, app] }))).toEqual([]);
    const foreign = duo({ surfaces: [kso, { ...app, designSystem: "yandex-pay" }] });
    expect(has(foreign, "surfaces/1/designSystem", `per-surface design systems are not supported yet (${SURFACE_DESIGN_SYSTEM_UNSUPPORTED_CODE})`)).toBe(true);
    const issue = issues(foreign).find((entry) => entry.path.join("/") === "surfaces/1/designSystem");
    expect((issue as { params?: { code?: string } }).params?.code).toBe(SURFACE_DESIGN_SYSTEM_UNSUPPORTED_CODE);
  });

  it("does not apply the authoring ban in the stored branch", () => {
    expect(storedPrototypeDocSchema.safeParse(duo({ surfaces: [kso, { ...app, designSystem: "yandex-pay" }] })).success).toBe(true);
  });
});

describe("stored branch tolerance", () => {
  it("reads a surfaces document that violates authoring-only rules", () => {
    const stored = duo({ device: "mobile", startScreen: "app-home", surfaces: [kso, app] });
    const parsed = storedPrototypeDocSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    // Экраны desktop-поверхности без canvas — тоже читаются (D2a — авторское правило).
    expect(storedPrototypeDocSchema.safeParse(duo({ screens: [screen("kso-idle", "kso"), screen("app-home", "app")] })).success).toBe(true);
  });

  it("reads a document with more surfaces than the v1 limit", () => {
    const third = { id: "till", name: "Касса", device: "tablet" as const, startScreen: "till-idle" };
    const stored = duo({
      surfaces: [kso, app, third],
      screens: [...duo().screens, screen("till-idle", "till")],
    });
    expect(storedPrototypeDocSchema.safeParse(stored).success).toBe(true);
  });
});

describe("surfaceOf and helpers (D4 fallbacks)", () => {
  const parsed = storedPrototypeDocSchema.parse(duo());

  it("resolves the surface of a tagged screen", () => {
    expect(surfaceOf(parsed, "kso-pay").id).toBe("kso");
    expect(surfaceOf(parsed, "app-receipt").id).toBe("app");
    expect(primarySurface(parsed).id).toBe("kso");
    expect(screensOfSurface(parsed, "app")).toEqual(["app-home", "app-receipt"]);
  });

  it("falls back to primary for an untagged screen, an unknown surface id and an unknown screen", () => {
    const damaged = { ...parsed, screens: [{ ...parsed.screens[0]!, surface: undefined }, { ...parsed.screens[2]!, surface: "gone" }] };
    expect(surfaceOf(damaged, "kso-idle").id).toBe("kso");
    expect(surfaceOf(damaged, "app-home").id).toBe("kso");
    expect(surfaceOf(parsed, "nowhere").id).toBe("kso");
  });

  it("synthesises a primary surface for a document without surfaces", () => {
    const plain = storedPrototypeDocSchema.parse({
      version: 1, id: "plain", name: "Plain", designSystem: "wireframe", device: "mobile", startScreen: "a", state: {},
      screens: [screen("a"), screen("b")],
    });
    const list = docSurfaces(plain);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "primary", device: "mobile", startScreen: "a", designSystem: "wireframe" });
    expect(surfaceOf(plain, "b").id).toBe("primary");
    expect(surfaceDesignSystem(list[0]!, plain)).toBe("wireframe");
  });

  it("defaults a surface design system to the document one", () => {
    expect(surfaceDesignSystem(primarySurface(parsed), parsed)).toBe("shadcn");
    expect(surfaceDesignSystem({ ...app, designSystem: "yandex-pay" }, parsed)).toBe("yandex-pay");
  });

  it("ignores unresolvable companion entries", () => {
    expect(resolveStepCompanions(parsed, { screenId: "kso-idle", companions: { app: "app-home" } }))
      .toEqual([{ surface: app, screenId: "app-home" }]);
    expect(resolveStepCompanions(parsed, {
      screenId: "kso-idle",
      companions: { kso: "kso-pay", gone: "app-home", app: "missing" },
    })).toEqual([]);
    expect(resolveStepCompanions(parsed, { screenId: "kso-idle" })).toEqual([]);
  });
});
