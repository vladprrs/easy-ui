import { expect, test } from "@playwright/test";
import { STARTER_DS_ID } from "../starter-ds.fixture";
import { createFixtureComponent } from "./reuse.fixture";

const api = "/api";
const source = `import { z } from "zod";
export const definition = {
  props: z.strictObject({ probeValue: z.string() }),
  events: [],
  slots: [],
  atomicLevel: "atom" as const,
  description: "Dedicated reuse-helper allowlist probe",
  example: { probeValue: "probe" },
};
export default function ReuseHelperProbe({ props }: { props: { probeValue: string } }) {
  return <output data-reuse-helper-probe>{props.probeValue}</output>;
}`;

test("fixture override rejects an unexpected authoritative candidate key", async ({ request }) => {
  const expected = await request.post(`${api}/components`, {
    data: {
      id: "reuse-helper-expected",
      name: "ReuseHelperExpected",
      source,
      designSystem: STARTER_DS_ID,
      intent: "Provides the expected candidate for the reuse helper allowlist regression",
    },
  });
  expect(expected.status()).toBe(201);

  let rejection: unknown;
  try {
    await createFixtureComponent(request, api, {
      id: "reuse-helper-unexpected",
      name: "ReuseHelperUnexpected",
      source,
      designSystem: STARTER_DS_ID,
      intent: "Attempts an unauthorized force-new fixture for allowlist regression coverage",
    }, {
      reason: "This reason must never be accepted for an unexpected reuse candidate",
      allowedCandidateKeys: [`component:${STARTER_DS_ID}:not-the-server-candidate`],
    });
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(`component:${STARTER_DS_ID}:reuse-helper-expected`);
  expect((await request.get(`${api}/components/reuse-helper-unexpected`)).status()).toBe(404);
});
