import { expect, test } from "@playwright/test";

const api = "http://127.0.0.1:8787/api";

// Combined custom component: typed event payload (choose) + named slots (header/body).
// Mirrors server/fixtures/typed-events-stars.tsx and named-slots-panel.tsx.
const comboSource = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ title: z.string() }),
  events: { choose: z.strictObject({ label: z.string(), value: z.number() }) },
  capabilities: { typedEvents: true, namedSlots: true } as const,
  slots: ["header", "body"],
  description: "A plan panel with header/body slots that emits a typed choose payload",
  example: { title: "Plans" },
};

type Props = z.output<typeof definition.props>;

export default function ComboPanel({ props, slots, emit }: EasyUIComponentProps<Props>) {
  return (
    <section>
      <h2>{props.title}</h2>
      <header>{slots?.header}</header>
      <div>{slots?.body}</div>
      <div>{slots?.default}</div>
      <button onClick={() => emit("choose", { label: "Pro plan", value: 42 })}>Pick pro</button>
      <button onClick={() => emit("choose", { label: "Free plan", value: 0 })}>Pick free</button>
    </section>
  );
}
`;

test("seeded composition-demo renders a repeat from state and navigates between screens", async ({ page }) => {
  await page.goto("/p/composition-demo");
  await expect(page).toHaveURL(/\/p\/composition-demo\/s\/board$/);

  const preview = page.getByLabel("Prototype device preview");

  // repeat over /tasks (3 items) with $item in props and $cond-driven status badges.
  await expect(preview.getByText("Design the flow")).toBeVisible();
  await expect(preview.getByText("Wire up the state")).toBeVisible();
  await expect(preview.getByText("Ship the demo")).toBeVisible();
  await expect(preview.getByText("Done")).toBeVisible();
  await expect(preview.getByText("Todo").first()).toBeVisible();

  // pushState grows the array; the repeat re-renders a fourth row.
  await preview.getByRole("button", { name: "Add task" }).click();
  await expect(preview.getByText("Review with team")).toBeVisible();

  // removeState drops the first item; the repeat re-renders three rows again.
  await preview.getByRole("button", { name: "Remove first" }).click();
  await expect(preview.getByText("Design the flow")).toHaveCount(0);
  await expect(preview.getByText("Review with team")).toBeVisible();

  // setState toggles a $state-gated tip off.
  await expect(preview.getByText(/Tip: use the buttons/)).toBeVisible();
  await preview.getByRole("button", { name: "Got it" }).click();
  await expect(preview.getByText(/Tip: use the buttons/)).toHaveCount(0);

  // navigate to the focus screen; the shared flow state carries over (stateOverrides
  // only seed the CJM tile's initial state, not in-session navigation), so the same
  // repeat template re-renders the current tasks array here.
  await preview.getByRole("button", { name: "Focus mode" }).click();
  await expect(page).toHaveURL(/\/p\/composition-demo\/s\/focus$/);
  await expect(preview.getByText("Wire up the state")).toBeVisible();
  await expect(preview.getByText("Review with team")).toBeVisible();

  await preview.getByRole("button", { name: "Back to board" }).click();
  await expect(page).toHaveURL(/\/p\/composition-demo\/s\/board$/);

  await preview.getByRole("button", { name: "Finish" }).click();
  await expect(page).toHaveURL(/\/p\/composition-demo\/s\/done$/);
  await expect(preview.getByText("All set")).toBeVisible();
});

test("typed event payload drives setState via $event, $if gates an action, slots route children, and the inspector logs the payload", async ({ request, page }) => {
  expect((await request.post(`${api}/components`, {
    data: { id: "combo-panel", name: "ComboPanel", source: comboSource },
  })).status()).toBe(201);
  expect((await request.post(`${api}/components/combo-panel/publish`, { data: { baseRev: 1 } })).status()).toBe(201);

  const doc = {
    version: 1,
    id: "typed-events-flow",
    name: "Typed events flow",
    device: "mobile",
    startScreen: "plans",
    state: { picked: "", hasAmount: false },
    screens: [
      {
        id: "plans", name: "Plans", spec: { root: "panel", elements: {
          panel: {
            type: "ComboPanel",
            props: { title: "Plans" },
            on: { choose: [
              { action: "setState", params: { statePath: "/picked", value: { $event: "/label" } } },
              { action: "setState", $if: { $event: "/value" }, params: { statePath: "/hasAmount", value: true } },
            ] },
            children: ["hdr", "picked", "amount"],
          },
          hdr: { type: "Text", slot: "header", props: { text: "Choose a plan" } },
          picked: { type: "Text", slot: "body", props: { text: { $template: "Picked: ${/picked}" } } },
          amount: { type: "Text", slot: "body", props: { text: "Amount applied" }, visible: { $state: "/hasAmount" } },
        } },
      },
    ],
  };
  expect((await request.post(`${api}/prototypes`, { data: { doc } })).status()).toBe(201);

  await page.goto("/p/typed-events-flow?debug=1");
  await expect(page).toHaveURL(/\/p\/typed-events-flow\/s\/plans/);

  const preview = page.getByLabel("Prototype device preview");
  // Named slots routed the children into the header/body regions.
  await expect(preview.getByText("Choose a plan")).toBeVisible();
  await expect(preview.getByText("Picked:", { exact: false })).toBeVisible();
  await expect(preview.getByText("Amount applied")).toHaveCount(0);

  // Free plan carries value 0: $event delivers the label, but $if (truthiness of /value) skips the amount action.
  await preview.getByRole("button", { name: "Pick free" }).click();
  await expect(preview.getByText("Picked: Free plan")).toBeVisible();
  await expect(preview.getByText("Amount applied")).toHaveCount(0);

  // Pro plan carries value 42: $event delivers the label and $if now passes, revealing the amount text.
  await preview.getByRole("button", { name: "Pick pro" }).click();
  await expect(preview.getByText("Picked: Pro plan")).toBeVisible();
  await expect(preview.getByText("Amount applied")).toBeVisible();

  // Inspector (?debug=1) logs the typed event with its payload.
  const inspector = page.getByRole("complementary", { name: "Interaction inspector" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText("choose", { exact: false }).first()).toBeVisible();
  await expect(inspector.getByText(/"label":"Pro plan"/)).toBeVisible();
  await expect(inspector.getByText(/"value":42/)).toBeVisible();
});
