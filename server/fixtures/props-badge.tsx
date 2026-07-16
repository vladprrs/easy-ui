import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

const sourceEscapingProbe = '<script>globalThis.componentPagePwned = true</script>';
void sourceEscapingProbe;

export const definition = {
  props: z.strictObject({
    label: z.string().min(1).describe("Badge label"),
    tone: z.enum(["neutral", "danger"]).describe("Visual tone"),
  }),
  events: [],
  slots: [],
  description: "Props badge version one",
  example: { label: "Version one", tone: "neutral" as const },
};

type Props = z.output<typeof definition.props>;

export default function PropsBadge({ props }: EasyUIComponentProps<Props>) {
  return <output data-props-badge data-tone={props.tone}>{props.label} · {props.tone}</output>;
}
