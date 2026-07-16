import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ text: z.string() }),
  description: "Starter text",
  atomicLevel: "atom" as const,
  example: { text: "Hello" },
};

export default function StarterText({ props }: EasyUIComponentProps<{ text: string }>) {
  return <p>{props.text}</p>;
}
