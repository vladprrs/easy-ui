import type { AtomicLevel } from "../types";

export const shadcnAtomicLevels = {
  Stack: "atom", Grid: "atom",
  Button: "atom", Link: "atom", Input: "atom", Textarea: "atom", Checkbox: "atom",
  Switch: "atom", Slider: "atom", Toggle: "atom", Heading: "atom", Text: "atom",
  Image: "atom", Avatar: "atom", Badge: "atom", Separator: "atom", Progress: "atom",
  Skeleton: "atom", Spinner: "atom", Hotspot: "atom",
  Select: "molecule", Radio: "molecule", DropdownMenu: "molecule", ToggleGroup: "molecule",
  ButtonGroup: "molecule", Pagination: "molecule", Tooltip: "molecule", Popover: "molecule",
  Alert: "molecule", Collapsible: "molecule", Accordion: "molecule", Carousel: "molecule",
  Card: "organism", Tabs: "organism", Dialog: "organism", Drawer: "organism", Table: "organism",
} as const satisfies Record<string, AtomicLevel>;

export const shadcnLayoutNeutral = new Set(["Stack", "Grid"]);
