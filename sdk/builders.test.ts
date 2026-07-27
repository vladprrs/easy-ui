import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { inputPrototypeDocSchema } from "../src/prototype/schema";
import { createAuthoring, SdkError, SdkValidationError, keyBase, toSpec, type ElementNode } from "./builders";
import type { CatalogComponents } from "./catalog.sdk-demo";

// Per-design-system binding: this is the only place a catalog type is named. Application code
// imports these bound builders (see docs/authoring-sdk.md).
const catalogNames = (JSON.parse(readFileSync(new URL("./fixtures/catalog.sdk-demo.json", import.meta.url), "utf8")) as { components: { name: string }[] })
  .components.map((component) => component.name);
const { component, screen, doc, host, actions, validateDoc } = createAuthoring<CatalogComponents>({ knownComponents: catalogNames });

const successScreen = () => screen({
  id: "success",
  name: "Success",
  root: screen.flowRoot({
    header: component("DemoNavBar", { title: "Оплата", tone: "light" }),
    content: [
      component("DemoBadge", { text: "Готово" }),
      component("DemoBadge", { text: { $state: "/status" } }, { key: "status-badge" }),
    ],
    footer: component("DemoActionFooter", { primaryLabel: "Готово" }, { on: { press: actions.navigate("start") } }),
    overlays: [host.overlay({ placement: "bottom" }, { children: [component("DemoBadge", { text: "Подсказка" })] })],
  }),
});

const startScreen = () => screen({
  id: "start",
  name: "Start",
  root: component("DemoScreenShell", { background: "surface" }, {
    children: [
      component("DemoNavBar", { title: "Старт", tone: "dark" }, { slot: "header" }),
      component("DemoBadge", { text: { $bindItem: "/label" } }, { slot: "content", repeat: { statePath: "/items", key: "id" } }),
      host.hotspot({ x: 0, y: 0, width: 10, height: 10, ariaLabel: "Дальше" }, { slot: "footer", on: { press: [actions.setState("/seen", true), actions.navigate("success")] } }),
    ],
  }),
});

describe("builders", () => {
  test("flattens a flowRoot screen into the {root, elements} spec with region markers", () => {
    const built = successScreen();
    expect(built.spec.root).toBe("flowRoot");
    expect(built.spec.elements.flowRoot).toMatchObject({
      type: "@eui/FlowRoot",
      props: {},
      children: ["demoNavBar", "demoBadge", "status-badge", "demoActionFooter", "overlay"],
    });
    expect(built.spec.elements.demoNavBar).toMatchObject({ type: "DemoNavBar", region: "header", props: { title: "Оплата", tone: "light" } });
    expect(built.spec.elements.demoActionFooter).toMatchObject({ region: "footer", on: { press: { action: "navigate", params: { screenId: "start" } } } });
    expect(built.spec.elements.demoBadge!.region).toBeUndefined();
    expect(built.spec.elements.overlay).toMatchObject({ type: "Overlay", children: ["demoBadge-2"] });
  });

  test("generates stable keys and honours explicit keys, slots, repeat and multi-action handlers", () => {
    expect(keyBase("@eui/FlowRoot")).toBe("flowRoot");
    expect(JSON.stringify(successScreen())).toBe(JSON.stringify(successScreen()));
    const built = startScreen();
    expect(built.spec.root).toBe("demoScreenShell");
    expect(built.spec.elements.demoNavBar!.slot).toBe("header");
    expect(built.spec.elements.demoBadge).toMatchObject({ slot: "content", repeat: { statePath: "/items", key: "id" } });
    expect(built.spec.elements.hotspot!.on!.press).toEqual([
      { action: "setState", params: { statePath: "/seen", value: true } },
      { action: "navigate", params: { screenId: "success" } },
    ]);
  });

  test("doc() output parses under the server's strict input schema", () => {
    const document = doc({
      id: "sdk-demo-flow",
      name: "SDK demo flow",
      designSystem: "sdk-demo",
      device: "mobile",
      state: { status: "ok", items: [] },
      screens: [startScreen(), successScreen()],
      flows: [{ id: "main", name: "Main", steps: [{ screenId: "start" }, { screenId: "success" }] }],
    });
    expect(inputPrototypeDocSchema.safeParse(document).success).toBe(true);
    expect(document).toMatchObject({ version: 1, startScreen: "start", device: "mobile" });
    // startScreen defaults to the first screen and state defaults to {}.
    expect(doc({ id: "d", name: "D", designSystem: "sdk-demo", screens: [successScreen()] })).toMatchObject({ startScreen: "success", state: {} });
  });

  test("rejects an invalid document with a readable list of zod issues", () => {
    const call = () => doc({ id: "Bad_Id", name: "", designSystem: "sdk-demo", screens: [successScreen()], startScreen: "missing" });
    expect(call).toThrow(SdkValidationError);
    try {
      call();
    } catch (error) {
      const issues = (error as SdkValidationError).issues;
      expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["/id", "/name", "/startScreen"]));
      expect((error as Error).message).toContain("/startScreen: startScreen must reference an existing screen");
    }
    expect(() => validateDoc({ version: 1 })).toThrow(SdkValidationError);
  });

  test("rejects unknown components, duplicate keys and `$` in authored keys at runtime", () => {
    expect(() => component("NotThere" as "DemoBadge", { text: "x" })).toThrow(/Unknown component "NotThere"/);
    expect(() => component("DemoBadge", { text: "x" }, { key: "a$b" })).toThrow(SdkError);
    const duplicate: ElementNode = component("DemoBadge", { text: "a" }, {
      key: "same",
      children: [component("DemoBadge", { text: "b" }, { key: "same" })],
    });
    expect(() => toSpec(duplicate)).toThrow(/Duplicate element key: same/);
    expect(() => doc({ id: "d", name: "D", designSystem: "sdk-demo", screens: [] })).toThrow(SdkError);
  });

  test("catches authoring mistakes at compile time", () => {
    // @ts-expect-error unknown component name
    expect(() => component("YpNope", { text: "x" })).toThrow();
    // @ts-expect-error `tone` only accepts the enum values declared by the catalog
    void (() => component("DemoNavBar", { title: "t", tone: "neon" }));
    // @ts-expect-error `title` is required
    void (() => component("DemoNavBar", { tone: "light" }));
    // @ts-expect-error DemoNavBar declares no events
    void (() => component("DemoNavBar", { title: "t", tone: "light" }, { on: { press: actions.back() } }));
    // @ts-expect-error `secondaryPress` exists, `tap` does not
    void (() => component("DemoActionFooter", { primaryLabel: "ok" }, { on: { tap: actions.back() } }));
    // @ts-expect-error region markers are a closed set
    void (() => component("DemoBadge", { text: "x" }, { region: "sidebar" }));
    expect(z).toBeDefined();
  });
});
