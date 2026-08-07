import { z } from "zod";
export const definition = {
  props: z.strictObject({ label: z.string().default("draft") }),
  events: [], slots: [],
  description: "Draft preview probe component",
  atomicLevel: "atom" as const,
  examples: { full: { label: "from-example" } },
};
export default function DraftStars({ props }: any) {
  return <div><span>{props.label}</span><img src="/api/assets/asset_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" alt="dot" /></div>;
}