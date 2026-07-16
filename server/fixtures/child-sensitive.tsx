import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  events: [],
  slots: [],
  description: "A slotless component that exposes accidental child injection",
  example: { label: "slotless" },
};

type Props = z.output<typeof definition.props>;

export default function ChildSensitive({ props, slots }: EasyUIComponentProps<Props>) {
  return <output data-child-sensitive>{props.label}: {slots?.default ? "children present" : "no children"}</output>;
}
