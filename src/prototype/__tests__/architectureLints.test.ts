import { describe, expect, it } from "vitest";
import { z } from "zod";
import monolithFixture from "../../../test/fixtures/architecture/monolith-screen.json";
import type { ComponentDefinition } from "../../catalog/definitions";
import { lintPrototypeArchitecture } from "../architectureLints";
import { prototypeDocSchema, type PrototypeDoc } from "../schema";
import { validatePrototype } from "../validate";

const definition = (extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  description: "test",
  props: z.looseObject({}),
  ...extra,
});

const screenComponent = definition({
  atomicLevel: "organism",
  scope: "screen",
  ownership: { reason: "переносим экран целиком из Figma" },
});

const doc = (
  elements: PrototypeDoc["screens"][number]["spec"]["elements"],
  root: string,
  extra: Partial<PrototypeDoc> = {},
): PrototypeDoc => prototypeDocSchema.parse({
  version: 1,
  id: "arch",
  name: "Arch",
  designSystem: "yandex-pay",
  startScreen: "s",
  state: {},
  screens: [{ id: "s", name: "S", spec: { root, elements } }],
  ...extra,
});

const codes = (result: { warnings: { code?: string }[] }) => result.warnings.map((entry) => entry.code);

describe("architecture lints", () => {
  it("flags a scope:screen component as the single child of @eui/FlowRoot (motivating case)", () => {
    const parsed = prototypeDocSchema.parse(structuredClone(monolithFixture));
    const definitions = { YpCtypMagnitPaymentSuccess: definition({ atomicLevel: "organism", scope: "screen" }) };
    const result = lintPrototypeArchitecture(parsed, definitions);
    expect(codes(result)).toEqual(expect.arrayContaining(["arch/monolith-root", "arch/ownership-unexplained"]));
    const monolith = result.warnings.find((entry) => entry.code === "arch/monolith-root")!;
    expect(monolith.path).toBe("/screens/0/spec/elements/screen");
    expect(monolith.message).toContain("monolithic screen");
    // Тот же issue приходит и через validatePrototype, и только как warning.
    const validated = validatePrototype(parsed, { definitions });
    expect(validated.errors).toEqual([]);
    expect(validated.warnings.map((entry) => entry.code)).toContain("arch/monolith-root");
  });

  it("never infers a scope from atomicLevel: a plain organism under FlowRoot stays clean", () => {
    const organism = definition({ atomicLevel: "organism" });
    const parsed = doc({
      root: { type: "@eui/FlowRoot", props: {}, children: ["one"] },
      one: { type: "Card", props: {} },
    }, "root");
    expect(lintPrototypeArchitecture(parsed, { Card: organism }).warnings).toEqual([]);
  });

  it("keeps the legacy monolithic-screen warning for a direct custom organism root", () => {
    const parsed = doc({ p: { type: "Page", props: {} } }, "p");
    const result = lintPrototypeArchitecture(parsed, { Page: definition({ atomicLevel: "page" }) });
    expect(codes(result)).toEqual(["arch/monolith-root"]);
    expect(result.warnings[0]!.message).toContain("is a single custom page with no children");
  });

  it("flags allowedAsRoot:false in a root position and a nested scope:screen component", () => {
    const parsed = doc({
      root: { type: "@eui/FlowRoot", props: {}, children: ["bar", "body"] },
      bar: { type: "Bar", props: {}, region: "header" },
      body: { type: "Box", props: {}, children: ["inner"] },
      inner: { type: "Screen", props: {} },
    }, "root");
    const result = lintPrototypeArchitecture(parsed, {
      Bar: definition({ allowedAsRoot: false }),
      Box: definition(),
      Screen: screenComponent,
    });
    expect(codes(result).sort()).toEqual(["arch/root-not-allowed", "arch/screen-scope-nested"]);
  });

  it("flags a shell/screen-scoped component owned by a region and a sourceBounded owner", () => {
    const parsed = doc({
      root: { type: "@eui/FlowRoot", props: {}, children: ["header", "content"] },
      header: { type: "Bar", props: {}, region: "header", children: ["shell"] },
      shell: { type: "Shell", props: {} },
      content: { type: "Box", props: {} },
    }, "root");
    const result = lintPrototypeArchitecture(parsed, {
      Bar: definition({ sourceBounded: true }),
      Shell: definition({ scope: "shell", ownership: { reason: "владеет скроллером" } }),
      Box: definition(),
    });
    expect(codes(result).sort()).toEqual(["arch/bounded-as-owner", "arch/region-owns-page"]);
  });

  it("warns when a shell/screen scope declares no ownership.reason", () => {
    const parsed = doc({ root: { type: "Shell", props: {} } }, "root");
    const result = lintPrototypeArchitecture(parsed, { Shell: definition({ scope: "shell" }) });
    expect(codes(result)).toEqual(expect.arrayContaining(["arch/ownership-unexplained"]));
    const explained = lintPrototypeArchitecture(parsed, { Shell: definition({ scope: "shell", ownership: { reason: "каркас экрана" } }) });
    expect(codes(explained)).not.toContain("arch/ownership-unexplained");
  });

  it("skips every rule for service prototype kinds", () => {
    const parsed = prototypeDocSchema.parse(structuredClone(monolithFixture));
    const definitions = { YpCtypMagnitPaymentSuccess: definition({ scope: "screen" }) };
    for (const kind of ["component-gallery", "evidence", "visual-reference", "composition-fixture"]) {
      expect(lintPrototypeArchitecture(parsed, definitions, { kind }).warnings).toEqual([]);
    }
    expect(lintPrototypeArchitecture(parsed, definitions, { kind: "product-flow" }).warnings.length).toBeGreaterThan(0);
    expect(validatePrototype(parsed, { definitions, kind: "evidence" }).warnings.filter((entry) => entry.code?.startsWith("arch/"))).toEqual([]);
  });

  it("suppresses an exempted issue and reports it as exempted", () => {
    const parsed = doc({ root: { type: "Shell", props: {} } }, "root", {
      architecture: {
        exemptions: [{ rule: "arch/ownership-unexplained", screenId: "s", reason: "легаси-каркас, переезд в волне 5" }],
      },
    });
    const result = lintPrototypeArchitecture(parsed, { Shell: definition({ scope: "shell" }) });
    expect(codes(result)).not.toContain("arch/ownership-unexplained");
    expect(result.exempted).toEqual([expect.objectContaining({
      code: "arch/ownership-unexplained",
      screenId: "s",
      elementKey: "root",
      reason: "легаси-каркас, переезд в волне 5",
    })]);
    expect(validatePrototype(parsed, { definitions: { Shell: definition({ scope: "shell" }) } }).architecture?.exempted).toHaveLength(1);
  });

  it("matches an exemption by elementKey when it is provided", () => {
    const elements = {
      root: { type: "@eui/FlowRoot", props: {}, children: ["a", "b"] },
      a: { type: "Shell", props: {} },
      b: { type: "Shell", props: {} },
    };
    const parsed = doc(elements, "root", {
      architecture: { exemptions: [{ rule: "arch/ownership-unexplained", screenId: "s", elementKey: "a", reason: "точечное исключение" }] },
    });
    const result = lintPrototypeArchitecture(parsed, { Shell: definition({ scope: "shell" }) });
    expect(result.warnings.map((entry) => entry.path)).toEqual(["/screens/0/spec/elements/b"]);
    expect(result.exempted.map((entry) => entry.elementKey)).toEqual(["a"]);
  });

  // M7: критерий волны — существующие фикстуры и шаблоны не получают новых warning'ов.
  // Здесь проверяется отсутствие `arch/*`; полное сравнение warning'ов до/после сделано
  // прогоном `scripts/validate-templates.ts` и diff'ом по всем фикстурам при реализации.
  it("adds no architecture warnings to existing fixtures and gallery templates", async () => {
    const fixtures = import.meta.glob("../../../test/fixtures/**/*.json", { eager: true }) as Record<string, { default: unknown }>;
    const { buildPrototypeTemplate } = await import("../../gallery/prototypeTemplates");
    const docs: [string, unknown][] = Object.entries(fixtures)
      .filter(([path]) => !path.includes("/architecture/"))
      .map(([path, module]) => [path, module.default]);
    docs.push(["gallery-template", buildPrototypeTemplate("yandex-pay", "gallery-template", "Gallery template")]);
    let checked = 0;
    for (const [name, raw] of docs) {
      const parsed = prototypeDocSchema.safeParse(raw);
      if (!parsed.success) continue;
      checked += 1;
      const result = validatePrototype(parsed.data);
      expect({ name, arch: result.warnings.filter((entry) => entry.code?.startsWith("arch/")) }).toEqual({ name, arch: [] });
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("does not duplicate the atomic-nesting warning for a nested scope:screen component", () => {
    const parsed = doc({
      root: { type: "Box", props: {}, children: ["inner"] },
      inner: { type: "Screen", props: {} },
    }, "root");
    const warnings = validatePrototype(parsed, {
      definitions: { Box: definition({ atomicLevel: "atom" }), Screen: screenComponent },
    }).warnings;
    expect(warnings.filter((entry) => entry.message.startsWith("atomic-design:"))).toEqual([]);
    expect(warnings.map((entry) => entry.code)).toContain("arch/screen-scope-nested");
  });
});
