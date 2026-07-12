import { useState } from "react";
import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ value: z.number().min(0).max(5) }),
  events: { rate: z.strictObject({ value: z.number() }) },
  capabilities: { typedEvents: true } as const,
  slots: [],
  description: "A rating that emits a typed rate payload",
  example: { value: 3 },
};

type Props = z.output<typeof definition.props>;

export default function TypedStars({ props, emit }: EasyUIComponentProps<Props>) {
  const [value, setValue] = useState(props.value);
  return <button onClick={() => { setValue(value + 1); emit("rate", { value: value + 1 }); }}>{"★".repeat(value)}</button>;
}
