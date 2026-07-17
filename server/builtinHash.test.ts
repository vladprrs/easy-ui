import { expect, test } from "bun:test";
import { z } from "zod";
import { builtinCatalogHash, builtinCatalogHashFor, emptyComponentManifestHash, legacyBuiltinCatalogHashFor, RENDER_CONTRACT_VERSION } from "./builtinHash";
import type { ComponentDefinition } from "../src/catalog/normalize";
import { canonicalSpacingScale } from "../src/designSystems/spacingScale";

test("shadcn builtin hash is stable for the current render contract",()=>{
  expect(RENDER_CONTRACT_VERSION).toBe(4);
  expect(builtinCatalogHash).toMatch(/^[a-f0-9]{64}$/);
  expect(builtinCatalogHashFor("shadcn")).toBe(builtinCatalogHash);
  expect(builtinCatalogHashFor("wireframe")).toMatch(/^[a-f0-9]{64}$/);
});

test("host primitives participate in the v4 compatibility hash",()=>{
  const extractionOnly=legacyBuiltinCatalogHashFor("shadcn");
  expect(builtinCatalogHash).not.toBe(extractionOnly);
});

test("legacy v2 hashes remain reproducible and immutable",()=>{
  expect(legacyBuiltinCatalogHashFor("shadcn")).toBe("5d28a8faa2c8fb2016c78f52cfdf3cda1606e37f6d0c81a692a6410ecec77e41");
  expect(legacyBuiltinCatalogHashFor("wireframe")).toBe("790b74a019635c4807b303b582bcbb3e4a5d9b5b556b6a80b3b87df7e4b5308d");
  expect(legacyBuiltinCatalogHashFor("custom",{})).toBe("e8f4e1df955e480da9d097101ab5dd2100e326c176637b0f64221b6b5cd5e279");
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
