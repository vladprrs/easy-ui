import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ amount: z.string().min(1) }),
  events: [],
  slots: [],
  atomicLevel: "molecule" as const,
  ownership: { reason: "Owns the irreducible amount formatting behavior of the success badge" },
  description: "Cashback accrual badge; used only from inside the CTYP success composition",
  example: { amount: "12 ₽" },
};

type Props = z.output<typeof definition.props>;

export default function CtypAccrualBadge({ props }: EasyUIComponentProps<Props>) {
  return <span data-ctyp-accrual>{props.amount}</span>;
}
