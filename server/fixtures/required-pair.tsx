import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ first: z.string().min(1), second: z.string().min(1) }),
  events: [],
  slots: [],
  description: "Two required props without an example or schema defaults",
};

type Props = z.output<typeof definition.props>;

export default function RequiredPair({ props }: EasyUIComponentProps<Props>) {
  return <output data-required-pair>{props.first} + {props.second}</output>;
}
