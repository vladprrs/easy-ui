import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string(), disabled: z.boolean().default(false) }),
  description: "Starter action button",
  atomicLevel: "atom" as const,
  events: ["press"],
  example: { label: "Continue", disabled: false },
};

export default function StarterButton({ props, emit }: EasyUIComponentProps<{ label: string; disabled: boolean }>) {
  return <button type="button" disabled={props.disabled} onClick={() => emit("press")}>{props.label}</button>;
}
