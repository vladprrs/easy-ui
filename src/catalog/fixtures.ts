export { fixtures } from "../designSystems/shadcn";
export type { CatalogFixture } from "../designSystems/fixtures";

export const expectedStoryIds = [
  "shadcn-atoms-button--default", "shadcn-atoms-input--default", "shadcn-atoms-input--bound-state",
  "shadcn-organisms-card--default", "shadcn-organisms-tabs--default", "shadcn-organisms-dialog--default",
  "shadcn-molecules-select--default", "shadcn-organisms-table--default", "shadcn-molecules-alert--default",
  "shadcn-atoms-hotspot--default", "shadcn-all-components--gallery",
  "wireframe-atoms-button--default", "wireframe-atoms-input--default", "wireframe-molecules-select--default",
  "wireframe-organisms-card--default", "wireframe-all-components--gallery",
] as const;
