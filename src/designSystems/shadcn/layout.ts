import type { ComponentLayout } from "../types";

export const shadcnLayouts = {
  Stack: {
    version: 1,
    spacing: ["gap"],
    flow: { kind: "flex", direction: { prop: "direction", vertical: ["vertical"], horizontal: ["horizontal"] } },
  },
  Grid: { version: 1, spacing: ["gap"] },
} as const satisfies Record<string, ComponentLayout>;
