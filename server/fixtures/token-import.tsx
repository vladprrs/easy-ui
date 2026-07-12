import { z } from "zod";
import { token } from "easy-ui/runtime";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({}),
  description: "Uses the easy-ui/runtime token helper (forces host ABI v2)",
  example: {},
};

export default function TokenUser(_props: EasyUIComponentProps<Record<string, never>>) {
  return <span>{token("color.brand")}</span>;
}
