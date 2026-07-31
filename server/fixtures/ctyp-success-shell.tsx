import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ tone: z.enum(["success", "neutral"]).optional() }),
  events: [],
  slots: [],
  atomicLevel: "organism" as const,
  scope: "section" as const,
  ownership: { reason: "Owns the shell layout behavior that cannot be expressed by screen composition slots" },
  description: "Vertical shell of the CTYP payment-success screen; renders its children in order",
  example: { tone: "success" as const },
};

type Props = z.output<typeof definition.props>;

export default function CtypSuccessShell({ props, children }: EasyUIComponentProps<Props>) {
  return <section data-ctyp-shell data-tone={props.tone ?? "success"}>{children}</section>;
}
