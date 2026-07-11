import { useState } from "react";
import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ value: z.number().min(0).max(5), label: z.string().min(1) }),
  events: ["press"],
  slots: [],
  description: "Interactive five-star rating with a label",
  example: { value: 3, label: "Rate it" },
};

type Props = z.output<typeof definition.props>;

export default function RatingStars({ props, emit }: BaseComponentProps<Props>) {
  const [value, setValue] = useState(props.value);
  return (
    <button
      type="button"
      style={{ fontSize: 24, background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 12px", cursor: "pointer" }}
      onClick={() => { setValue(value >= 5 ? 0 : value + 1); emit("press"); }}
    >
      {props.label} {"★".repeat(value)}{"☆".repeat(5 - value)}
    </button>
  );
}
