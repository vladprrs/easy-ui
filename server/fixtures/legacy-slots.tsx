import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ title: z.string() }),
  events: [],
  slots: ["header", "items"],
  description: "Legacy slots collapse routed markup into the default slot",
  example: { title: "Legacy panel" },
};

type Props = z.output<typeof definition.props>;

export default function LegacySlots({ props, slots }: EasyUIComponentProps<Props>) {
  return <section data-legacy-slots><h2>{props.title}</h2><div>{slots?.default}</div></section>;
}
