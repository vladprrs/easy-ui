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
  // Ретайрнутые системы пинованы картой `retiredBuiltinV2Hashes` — их значения историчны и
  // неподвижны, что бы ни случилось с определениями.
  expect(legacyBuiltinCatalogHashFor("shadcn")).toBe("5d28a8faa2c8fb2016c78f52cfdf3cda1606e37f6d0c81a692a6410ecec77e41");
  expect(legacyBuiltinCatalogHashFor("wireframe")).toBe("790b74a019635c4807b303b582bcbb3e4a5d9b5b556b6a80b3b87df7e4b5308d");
  // …а вот `custom` пересчитывается **живьём** по extraction-примитивам, поэтому значение движется
  // вместе с определением `Overlay`. Сдвиг 2026-08-06 (§W5 T5a): у примитива появился prop
  // `scroll`. Это сентинел регрессий, а не историческое значение хранимых ревизий: у реальной
  // custom-ДС в пре-образ едут её собственные определения.
  expect(legacyBuiltinCatalogHashFor("custom",{})).toBe("d7c15a048e99f868163a1aee7ff93a606f7d1175e6399680a49f531c6f67acff");
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
