import { z } from "zod";

const statePath = z.string().startsWith("/");

export const customCatalogActions = {
  navigate: {
    params: z.strictObject({ screenId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }),
    description: "Navigate to another prototype screen.",
  },
  back: {
    params: z.strictObject({}),
    description: "Navigate back within the current prototype flow.",
  },
  openUrl: {
    params: z.strictObject({ url: z.url() }),
    description: "Open an external URL in a new tab.",
  },
  restart: {
    params: z.strictObject({}),
    description: "Restart the current prototype session.",
  },
} as const;

export const prototypeActionSchemas = {
  ...customCatalogActions,
  setState: {
    params: z.strictObject({ statePath, value: z.unknown() }),
    description: "Set a state value.",
  },
  pushState: {
    params: z.strictObject({
      statePath,
      value: z.unknown(),
      clearStatePath: statePath.optional(),
    }),
    description: "Append a value to a state array.",
  },
  removeState: {
    params: z.strictObject({ statePath, index: z.number().int().nonnegative() }),
    description: "Remove an indexed value from a state array.",
  },
} as const;
