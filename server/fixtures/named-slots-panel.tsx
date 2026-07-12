import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ title: z.string() }),
  events: [],
  capabilities: { namedSlots: true } as const,
  slots: ["header", "items"],
  description: "A panel that routes children into header and items slots",
  example: { title: "Panel" },
};

type Props = z.output<typeof definition.props>;

export default function NamedSlotsPanel({ props, slots }: EasyUIComponentProps<Props>) {
  return (
    <section>
      <h2>{props.title}</h2>
      <header>{slots?.header}</header>
      <ul>{slots?.items}</ul>
      <div>{slots?.default}</div>
    </section>
  );
}
