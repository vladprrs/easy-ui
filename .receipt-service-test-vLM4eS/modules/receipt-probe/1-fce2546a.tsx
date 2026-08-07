import { z } from "zod";
export const definition = {
  props: z.strictObject({ label: z.string().default("receipt") }),
  events: [], slots: [],
  description: "Receipt probe component",
  atomicLevel: "atom" as const,
  examples: { full: { label: "receipt" } },
};
export default function ReceiptProbe({ props }: any) {
  return <div><span>{props.label}</span></div>;
}