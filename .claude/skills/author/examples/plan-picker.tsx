import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

// ABI v2 component: typed event payload + named slots. Publishing this sets
// hostAbiVersion 2 automatically (capabilities and/or the easy-ui/runtime import).
export const definition = {
  props: z.strictObject({
    plans: z.array(z.strictObject({ id: z.string(), title: z.string(), price: z.number() })),
    selected: z.string().optional(),
  }),
  events: {
    // Typed payload: the player validates emitted payloads against this schema,
    // and the prototype can bind parts of it via {"$event": "/pointer"}.
    choose: z.object({ id: z.string(), price: z.number() }),
  },
  slots: ["header", "footer"],
  capabilities: { typedEvents: true, namedSlots: true } as const,
  description: "Plan picker with a typed choose event and header/footer slots",
  example: { plans: [{ id: "free", title: "Free", price: 0 }, { id: "pro", title: "Pro", price: 42 }] },
  atomicLevel: "organism" as const,
};

type Props = z.output<typeof definition.props>;

// Default {} keeps the advisory publish smoke (which renders without the player
// adapter, i.e. without slots) warning-free.
export default function PlanPicker({ props, emit, slots = {} }: EasyUIComponentProps<Props>) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {slots.header}
      {props.plans.map((plan) => (
        <button
          key={plan.id}
          onClick={() => emit("choose", { id: plan.id, price: plan.price })}
          style={{
            padding: 12,
            borderRadius: 12,
            border: plan.id === props.selected ? "2px solid var(--primary)" : "1px solid var(--border)",
            textAlign: "left",
          }}
        >
          {plan.title} — {plan.price === 0 ? "free" : `$${plan.price}`}
        </button>
      ))}
      {slots.footer}
    </div>
  );
}
