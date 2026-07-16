import { expect, test } from "@playwright/test";
import { authenticatedRequest } from "../auth";
import { AUTH_PREVIEW_LEGACY_BASIC, SHARE_PROTOTYPE_ID, SHARE_PROTOTYPE_NAME } from "../share/fixture";

test("provision an API-owned auth-preview fixture", async ({ baseURL }) => {
  expect(baseURL).toBeTruthy();
  const request = await authenticatedRequest(baseURL!, { legacyBasicAuth: AUTH_PREVIEW_LEGACY_BASIC });
  const existing = await request.get(`/api/prototypes/${SHARE_PROTOTYPE_ID}`);
  if (existing.status() === 404) {
    const doc = {
      version: 1,
      id: SHARE_PROTOTYPE_ID,
      name: SHARE_PROTOTYPE_NAME,
      description: "Created by the auth-preview setup project.",
      designSystem: "shadcn",
      device: "mobile",
      startScreen: "welcome",
      state: { name: "Ada" },
      screens: [
        { id: "welcome", name: "Welcome", spec: { root: "card", elements: {
          card: { type: "Card", props: { title: "Welcome" }, children: ["name", "next"] },
          name: { type: "Input", props: { label: "Name", name: "name", value: { $bindState: "/name" } } },
          next: { type: "Button", props: { label: "Details" }, on: { press: { action: "navigate", params: { screenId: "details" } } } },
        } } },
        { id: "details", name: "Details", spec: { root: "card", elements: {
          card: { type: "Card", props: { title: "Details" }, children: ["copy", "back"] },
          copy: { type: "Text", props: { text: "Share fixture second screen." } },
          back: { type: "Button", props: { label: "Back" }, on: { press: { action: "back", params: {} } } },
        } } },
      ],
    };
    const created = await request.post("/api/prototypes", { data: { doc, message: "Auth-preview e2e fixture" } });
    expect(created.status(), await created.text()).toBe(201);
  }
  const meta = await (await request.get(`/api/prototypes/${SHARE_PROTOTYPE_ID}`)).json() as { headRev: number; latestVersion: number | null };
  if (meta.latestVersion === null) {
    const published = await request.post(`/api/prototypes/${SHARE_PROTOTYPE_ID}/publish`, { data: { baseRev: meta.headRev, message: "Share e2e" } });
    expect(published.status(), await published.text()).toBe(201);
  }
  await request.dispose();
});
