import { expect, test } from "@playwright/test";
import { STARTER_DS_ID, STARTER_STACK, STARTER_TEXT, ensureStarterDesignSystem } from "../starter-ds.fixture";

const api = "/api";

/** Molecule: atoms only, one parameter and one slot. */
const rowDoc = (label: string) => ({
  version: 2,
  name: `V2 payment row ${label}`,
  atomicLevel: "molecule",
  scope: "section",
  params: { label: { type: "string", required: true } },
  slots: ["trailing"],
  spec: {
    root: "stack",
    elements: {
      stack: { type: STARTER_STACK, props: { gap: "sm" }, children: ["title", "note", "trailing"] },
      title: { type: STARTER_TEXT, props: { text: { $param: "label" } } },
      note: { type: STARTER_TEXT, props: { text: `row build ${label}` } },
      trailing: { type: "@eui/Slot", props: { name: "trailing" } },
    },
  },
});

/** Organism: built from the molecule above, forwarding its own param and slot downwards. */
const panelDoc = {
  version: 2,
  name: "V2 payment panel",
  atomicLevel: "organism",
  scope: "section",
  params: { heading: { type: "string", required: true } },
  slots: ["footer"],
  spec: {
    root: "stack",
    elements: {
      stack: { type: STARTER_STACK, props: { gap: "md" }, children: ["row"] },
      row: {
        type: "@eui/Composition",
        props: { composition: "v2-row", params: { label: { $param: "heading" } } },
        children: ["footer"],
      },
      // The organism's own slot is placed into the molecule's `trailing` slot, so a child
      // routed by the screen travels two levels down.
      footer: { type: "@eui/Slot", props: { name: "footer" }, slot: "trailing" },
    },
  },
};

const prototypeDoc = {
  version: 1,
  id: "v2-nested-flow",
  name: "V2 nested flow",
  designSystem: STARTER_DS_ID,
  device: "mobile",
  startScreen: "home",
  state: {},
  screens: [
    {
      id: "home",
      name: "Home",
      spec: {
        root: "panel",
        elements: {
          panel: {
            type: "@eui/Composition",
            props: { composition: "v2-panel", params: { heading: "Pay with card" } },
            children: ["tail"],
          },
          tail: { type: STARTER_TEXT, slot: "footer", props: { text: "Footer from the screen" } },
        },
      },
    },
  ],
};

test("nested v2 compositions expand, pin the whole closure and stay frozen in published versions", async ({ request, page }) => {
  await ensureStarterDesignSystem(request);

  // The agent builds a molecule from atoms, then an organism from that molecule.
  expect((await request.post(`${api}/compositions`, { data: { id: "v2-row", designSystem: STARTER_DS_ID, doc: rowDoc("one") } })).status()).toBe(201);
  expect((await request.post(`${api}/compositions/v2-row/publish`, { data: { baseRev: 1 } })).status()).toBe(201);
  expect((await request.post(`${api}/compositions`, { data: { id: "v2-panel", designSystem: STARTER_DS_ID, doc: panelDoc } })).status()).toBe(201);
  expect((await request.post(`${api}/compositions/v2-panel/publish`, { data: { baseRev: 1 } })).status()).toBe(201);

  // Saving the prototype expands the nested closure and pins the transitive set, not just the host.
  const created = await request.post(`${api}/prototypes`, { data: { doc: prototypeDoc } });
  expect(created.status(), await created.text()).toBe(201);
  const draft = await (await request.get(`${api}/prototypes/v2-nested-flow/draft`)).json() as { compositions: { id: string; version: number }[]; components: { name: string }[] };
  expect(draft.compositions.map((pin) => `${pin.id}@${pin.version}`).sort()).toEqual(["v2-panel@1", "v2-row@1"]);
  // Components reachable only through the nested composition are pinned too.
  expect(draft.components.map((pin) => pin.name).sort()).toEqual([STARTER_STACK, STARTER_TEXT]);

  expect((await request.post(`${api}/prototypes/v2-nested-flow/publish`, { data: { baseRev: 1 } })).status()).toBe(201);

  // The player renders through both layers: the outer param reaches the molecule, and the
  // screen's child travels through the organism slot into the molecule's slot.
  await page.goto("/p/v2-nested-flow");
  const preview = page.getByLabel("Превью прототипа на устройстве");
  await expect(preview.getByText("Pay with card")).toBeVisible();
  await expect(preview.getByText("row build one")).toBeVisible();
  await expect(preview.getByText("Footer from the screen")).toBeVisible();

  // Republishing the nested molecule must not touch the already published version.
  expect((await request.put(`${api}/compositions/v2-row`, { data: { doc: rowDoc("two"), baseRev: 1 } })).status()).toBe(200);
  expect((await request.post(`${api}/compositions/v2-row/publish`, { data: { baseRev: 2 } })).status()).toBe(201);

  const published = await (await request.get(`${api}/prototypes/v2-nested-flow/versions/1`)).json() as { compositions: { id: string; version: number }[] };
  expect(published.compositions.map((pin) => `${pin.id}@${pin.version}`).sort()).toEqual(["v2-panel@1", "v2-row@1"]);
  await page.goto("/p/v2-nested-flow/v/1");
  await expect(preview.getByText("row build one")).toBeVisible();
  await expect(preview.getByText("row build two")).toHaveCount(0);
});

test("a composition cycle is refused with the full path", async ({ request }) => {
  await ensureStarterDesignSystem(request);

  const selfReference = {
    version: 2,
    name: "V2 cycle root",
    atomicLevel: "organism",
    params: {},
    slots: [],
    spec: { root: "ref", elements: { ref: { type: "@eui/Composition", props: { composition: "v2-cycle" } } } },
  };
  expect((await request.post(`${api}/compositions`, { data: { id: "v2-cycle", designSystem: STARTER_DS_ID, doc: selfReference } })).status()).toBe(201);
  const publish = await request.post(`${api}/compositions/v2-cycle/publish`, { data: { baseRev: 1 } });
  // The reference cannot resolve before the composition has any published version, and once it
  // could, the closure would be cyclic: either way publication is refused, never accepted.
  expect(publish.status()).toBe(422);
  expect((await (await request.get(`${api}/compositions/v2-cycle`)).json() as { versions: unknown[] }).versions).toEqual([]);
});
