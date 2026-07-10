import { z } from "zod";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";

const fixture = join(process.cwd(), "scripts", `.easy-ui-custom-${crypto.randomUUID()}.tsx`);
await writeFile(fixture, `
  import { z } from "zod";
  export const definition = {
    description: "A fixture rating component.",
    props: z.strictObject({ value: z.number().int().min(1).max(5) }),
    events: ["change"],
  };
  export default function RatingStars({ value }: { value: number }) {
    return <span>{"★".repeat(value)}</span>;
  }
`);

try {
  const module = await import(fixture);
  if (!(module.definition.props instanceof z.ZodType)) throw new Error("Custom definition props is not a ZodType");
  if (typeof module.default !== "function") throw new Error("Custom component has no default function export");
  console.log("Bun imported custom TSX with a Zod definition");
} finally {
  await rm(fixture, { force: true });
}
