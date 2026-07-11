import { expect, test } from "bun:test";
import { builtinCatalogHash, builtinCatalogHashFor } from "./builtinHash";

test("shadcn builtin hash remains byte-for-byte compatible",()=>{
  expect(builtinCatalogHash).toBe("a881ef921e684f0756c31398ef176f7d2c4d910f69390c63b051cb3f9d4ce9d7");
  expect(builtinCatalogHashFor("shadcn")).toBe(builtinCatalogHash);
  expect(builtinCatalogHashFor("wireframe")).toMatch(/^[a-f0-9]{64}$/);
});
