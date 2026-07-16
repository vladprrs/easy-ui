import { expect, test } from "bun:test";
import { z } from "zod";
import { builtinCatalogHash, builtinCatalogHashFor, emptyComponentManifestHash, RENDER_CONTRACT_VERSION } from "./builtinHash";
import type { ComponentDefinition } from "../src/catalog/normalize";
import { canonicalSpacingScale } from "../src/designSystems/spacingScale";

test("shadcn builtin hash is stable for the current render contract",()=>{
  expect(RENDER_CONTRACT_VERSION).toBe(2);
  expect(builtinCatalogHash).toMatch(/^[a-f0-9]{64}$/);
  expect(builtinCatalogHashFor("shadcn")).toBe(builtinCatalogHash);
  expect(builtinCatalogHashFor("wireframe")).toMatch(/^[a-f0-9]{64}$/);
});

test("exposing Overlay changes the builtin compatibility hash",()=>{
  const beforeOverlay=builtinCatalogHashFor("shadcn",undefined,canonicalSpacingScale,{});
  expect(builtinCatalogHash).not.toBe(beforeOverlay);
});

test("resolved spacing scale participates in the compatibility hash",()=>{
  const changed={...canonicalSpacingScale,md:"20px"};
  expect(builtinCatalogHashFor("shadcn",undefined,changed)).not.toBe(builtinCatalogHashFor("shadcn",undefined,canonicalSpacingScale));
});

test("layout metadata participates in the compatibility hash",()=>{
  const base:Record<string,ComponentDefinition>={Box:{props:z.object({gap:z.enum(["sm","md"])}),description:"box"}};
  const withLayout:Record<string,ComponentDefinition>={Box:{...base.Box!,layout:{version:1,spacing:["gap"]}}};
  expect(builtinCatalogHashFor("custom",base)).not.toBe(builtinCatalogHashFor("custom",withLayout));
});

test("provider-less builtin descriptor hash is stable and distinct from an empty manifest",()=>{
  const first=builtinCatalogHashFor("custom",{});
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(builtinCatalogHashFor("custom",{})).toBe(first);
  expect(first).not.toBe(emptyComponentManifestHash);
});
