import { useState } from "react";
import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ value: z.number().min(0).max(5) }),
  events: ["press"],
  slots: [],
  description: "An interactive five-star rating",
  example: { value: 3 },
};

type Props = z.output<typeof definition.props>;

export default function RatingStars({ props, emit }: BaseComponentProps<Props>) {
  const [value, setValue] = useState(props.value);
  return <button onClick={() => { setValue(value + 1); emit("press"); }}>{"★".repeat(value)}</button>;
}
