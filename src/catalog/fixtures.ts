import type { Spec } from "@json-render/core";
import { componentDefinitions } from "./definitions";

type ComponentName = keyof typeof componentDefinitions;
export type CatalogFixture = Spec["elements"][string];

const fixtureOverrides: Record<string, Record<string, unknown>> = {
  Separator: { orientation: "horizontal" },
  Tabs: { tabs: [{ label: "Overview", value: "overview" }, { label: "Activity", value: "activity" }], defaultValue: "overview" },
  Accordion: { items: [{ title: "What is easy-ui?", content: "A catalog-driven prototype viewer." }], type: "single" },
  Collapsible: { title: "More details", defaultOpen: false },
  Dialog: { title: "Confirm action", description: "This dialog is controlled by catalog state.", openPath: "/dialogOpen" },
  Drawer: { title: "Quick settings", description: "A bottom drawer example.", openPath: "/drawerOpen" },
  Carousel: { items: [{ title: "First", description: "First slide" }, { title: "Second", description: "Second slide" }] },
  Image: { alt: "Landscape placeholder", width: 320, height: 180 },
  Skeleton: { width: "16rem", height: "2rem", rounded: true },
  Spinner: { size: "md", label: "Loading" },
  Tooltip: { content: "Helpful context", text: "Hover for help" },
  Popover: { trigger: "Open details", content: "Popover content" },
  Textarea: { label: "Notes", name: "notes", placeholder: "Add a note", rows: 4 },
  Select: { label: "Role", name: "role", options: ["Designer", "Developer", "Product manager"], placeholder: "Choose a role" },
  Checkbox: { label: "Accept terms", name: "terms", checked: false },
  Radio: { label: "Plan", name: "plan", options: ["Free", "Pro"], value: "Free" },
  Switch: { label: "Email notifications", name: "notifications", checked: true },
  Slider: { label: "Volume", min: 0, max: 100, step: 5, value: 60 },
  Link: { label: "Visit documentation", href: "https://example.com/docs" },
  DropdownMenu: { label: "Actions", items: [{ label: "Duplicate", value: "duplicate" }, { label: "Archive", value: "archive" }] },
  Toggle: { label: "Bold", pressed: false, variant: "outline" },
  ToggleGroup: { items: [{ label: "Left", value: "left" }, { label: "Center", value: "center" }], type: "single", value: "left" },
  ButtonGroup: { buttons: [{ label: "Day", value: "day" }, { label: "Week", value: "week" }], selected: "day" },
  Pagination: { totalPages: 8, page: 2 },
  Hotspot: { x: 24, y: 24, width: 96, height: 48, ariaLabel: "Open product details" },
};

export const fixtures = Object.fromEntries(
  Object.entries(componentDefinitions).map(([name, rawDefinition]) => [
    name,
    {
      type: name,
      props: (rawDefinition as { example?: Record<string, unknown> }).example ?? fixtureOverrides[name],
      children: [],
    },
  ]),
) as unknown as Record<ComponentName, CatalogFixture>;

export const expectedStoryIds = [
  "catalog-button--default",
  "catalog-input--default",
  "catalog-input--bound-state",
  "catalog-card--default",
  "catalog-tabs--default",
  "catalog-dialog--default",
  "catalog-select--default",
  "catalog-table--default",
  "catalog-alert--default",
  "catalog-hotspot--default",
  "catalog-all-components--gallery",
] as const;
