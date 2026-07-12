import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({}),
  // A transform pipe cannot be represented as JSON Schema, so publish must fail closed.
  events: { changed: z.string().transform((value) => value.length) },
  capabilities: { typedEvents: true } as const,
  description: "Component with a non-serializable typed event payload",
  example: {},
};

export default function NonSerializable(_props: EasyUIComponentProps<Record<string, never>>) {
  return null;
}
