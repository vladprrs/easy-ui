import { describe, expect, it } from "vitest";
import helloDocument from "../../../prototypes/hello-world.json";
import { prototypeDocSchema } from "../schema";
import { validatePrototype } from "../validate";

const hello: unknown = helloDocument;

// Mutation-heavy negative fixtures intentionally use a loose JSON shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clone(): Record<string, any> { return structuredClone(hello) as Record<string, any>; }
function messages(raw: unknown): string[] {
  const parsed = prototypeDocSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((entry) => `${entry.path.join("/")}: ${entry.message}`);
  return validatePrototype(parsed.data).errors.map((entry) => `${entry.path}: ${entry.message}`);
}
function expectInvalid(raw: unknown, pattern: RegExp) { expect(messages(raw).join("\n")).toMatch(pattern); }

describe("prototype v1 validation", () => {
  it("accepts hello-world", () => expect(messages(hello)).toEqual([]));

  it("rejects a children cycle", () => { const d=clone(); d.screens[0].spec.elements.next.children=["card"]; expectInvalid(d,/cycle/); });
  it("rejects an element with a second parent", () => { const d=clone(); d.screens[0].spec.elements.greeting.children=["next"]; expectInvalid(d,/more than one parent/); });
  it("rejects an unknown type", () => { const d=clone(); d.screens[0].spec.elements.next.type="Mystery"; expectInvalid(d,/unknown component type/); });
  it("rejects an unknown nested prop", () => { const d=clone(); d.screens[0].spec.elements.name.props.checks=[{ type:"required", message:"Required", extra:true }]; expectInvalid(d,/Unrecognized key|extra/); });
  it("rejects an unknown event", () => { const d=clone(); d.screens[0].spec.elements.next.on.click=d.screens[0].spec.elements.next.on.press; delete d.screens[0].spec.elements.next.on.press; expectInvalid(d,/unknown event/); });
  it("rejects an unknown action", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.action="launch"; expectInvalid(d,/unknown action/); });
  it("rejects invalid action params", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.params={}; expectInvalid(d,/screenId|Invalid input/); });
  it("rejects dynamic action params", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.params.screenId={$state:"/target"}; expectInvalid(d,/static literals/); });
  it("rejects two terminal actions", () => { const d=clone(); d.screens[0].spec.elements.next.on.press=[{action:"back",params:{}},{action:"navigate",params:{screenId:"details"}}]; expectInvalid(d,/at most one terminal/); });
  it("rejects a missing navigate target", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.params.screenId="missing"; expectInvalid(d,/target does not exist/); });
  it("rejects spec.state", () => { const d=clone(); d.screens[0].spec.state={}; expectInvalid(d,/Unrecognized key.*state/); });
  it("rejects watch", () => { const d=clone(); d.screens[0].spec.elements.next.watch={}; expectInvalid(d,/Unrecognized key.*watch/); });
  it("rejects repeat", () => { const d=clone(); d.screens[0].spec.elements.next.repeat={statePath:"/items"}; expectInvalid(d,/Unrecognized key.*repeat/); });
  it("rejects a reserved state path", () => { const d=clone(); d.screens[0].spec.elements.next.on.press={action:"setState",params:{statePath:"/_viewer/x",value:true}}; expectInvalid(d,/reserved viewer namespace/); });
  it("rejects a javascript URL", () => { const d=clone(); d.screens[0].spec.elements.next.on.press={action:"openUrl",params:{url:"javascript:alert(1)"}}; expectInvalid(d,/http\(s\)/); });
  it("rejects a dynamic Image src", () => { const d=clone(); d.screens[0].spec.elements.greeting={type:"Image",props:{src:{$state:"/image"},alt:"x"}}; expectInvalid(d,/URL must be a static string/); });
  it("requires preventDefault for Link navigation", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Link",props:{label:"Details",href:"https://example.com"},on:{press:{action:"navigate",params:{screenId:"details"}}}}; expectInvalid(d,/preventDefault/); });
  it("rejects Hotspot without canvas", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Hotspot",props:{x:0,y:0,width:10,height:10,ariaLabel:"Next"}}; expectInvalid(d,/requires a screen canvas/); });
  it("rejects Hotspot outside canvas", () => { const d=clone(); d.screens[0].canvas={width:100,height:100}; d.screens[0].spec.elements.next={type:"Hotspot",props:{x:95,y:0,width:10,height:10,ariaLabel:"Next"}}; expectInvalid(d,/outside canvas bounds/); });
  it("rejects an unknown $cond operator", () => { const d=clone(); d.screens[0].spec.elements.greeting.props.text={$cond:{if:{$state:"/name",contains:"A"},then:"yes",else:"no"}}; expectInvalid(d,/unknown condition operator/); });
});

describe("repository prototypes", () => {
  const files = import.meta.glob("../../../prototypes/*.json", { eager: true, import: "default" });
  for (const [filename, document] of Object.entries(files)) it(`${filename} is valid`, () => expect(messages(document)).toEqual([]));
});
