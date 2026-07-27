// Typed authoring SDK for easy-ui prototypes.
//
//   import { createAuthoring } from "../sdk";
//   import type { CatalogComponents } from "../sdk/catalog.sdk-demo";
//   const { component, screen, doc, actions, host } = createAuthoring<CatalogComponents>();
//
// Catalog types are generated per design system by `scripts/generate-sdk.ts`
// (`npm run generate:sdk -- --design-system <id>`); see docs/authoring-sdk.md.
export * from "./builders";
