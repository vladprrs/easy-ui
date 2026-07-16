import { useState } from "react";
import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string().min(1), crash: z.boolean() }),
  events: [],
  slots: [],
  description: "Local state survives ordinary prop updates and can exercise recovery",
  example: { label: "alpha", crash: false },
};

type Props = z.output<typeof definition.props>;

export default function LocalState({ props }: EasyUIComponentProps<Props>) {
  const [count, setCount] = useState(0);
  if (props.crash) throw new Error("Requested fixture crash");
  return <div data-local-state>
    <p>prop: {props.label}</p>
    <button type="button" onClick={() => setCount((value) => value + 1)}>count: {count}</button>
  </div>;
}
