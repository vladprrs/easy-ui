import { cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { Layout } from "./Layout";
import { PrototypeChrome, type PrototypeChromeProps } from "./PrototypeChrome";
import { appShell, prototypeChrome } from "./strings/common";

afterEach(cleanup);

function renderChrome(props: Partial<PrototypeChromeProps> = {}) {
  const router = createMemoryRouter(
    [{ path: "*", element: <PrototypeChrome prototypeId="demo" prototypeName="Demo proto" view="player" {...props} /> }],
    { initialEntries: ["/p/demo"] },
  );
  render(<RouterProvider router={router} />);
}

const linkHref = (name: string | RegExp) => screen.getByRole("link", { name }).getAttribute("href");

describe("PrototypeChrome", () => {
  it("renders the breadcrumb and draft segment links, marking the active view", () => {
    renderChrome({ view: "cjm" });
    expect(linkHref(prototypeChrome.gallery)).toBe("/");
    expect(screen.getByRole("heading", { name: "Demo proto" })).toBeTruthy();
    expect(linkHref(prototypeChrome.player)).toBe("/p/demo");
    expect(linkHref(prototypeChrome.cjm)).toBe("/p/demo/cjm");
    expect(linkHref(prototypeChrome.editor)).toBe("/p/demo/edit");
    expect(screen.getByRole("link", { name: prototypeChrome.cjm }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: prototypeChrome.player }).getAttribute("aria-current")).toBeNull();
    expect(screen.queryByText(prototypeChrome.draftBadge)).toBeNull();
    expect(screen.queryByText(prototypeChrome.versionBadge(1))).toBeNull();
  });

  it("keeps /v/N in player and CJM links while the editor goes to the draft with an explicit badge", () => {
    renderChrome({ view: "player", version: 3 });
    expect(linkHref(prototypeChrome.player)).toBe("/p/demo/v/3");
    expect(linkHref(prototypeChrome.cjm)).toBe("/p/demo/v/3/cjm");
    const editorLink = screen.getByRole("link", { name: new RegExp(prototypeChrome.editor) });
    expect(editorLink.getAttribute("href")).toBe("/p/demo/edit");
    expect(within(editorLink as HTMLElement).getByText(prototypeChrome.draftBadge)).toBeTruthy();
    expect(screen.getByText(prototypeChrome.versionBadge(3))).toBeTruthy();
  });

  it("encodes the prototype id in segment links", () => {
    renderChrome({ prototypeId: "прото 1" });
    expect(linkHref(prototypeChrome.player)).toBe(`/p/${encodeURIComponent("прото 1")}`);
    expect(linkHref(prototypeChrome.editor)).toBe(`/p/${encodeURIComponent("прото 1")}/edit`);
  });

  it("renders the status and actions slots when provided and hides their containers otherwise", () => {
    renderChrome({
      status: <span>slot-status</span>,
      actions: <button type="button">slot-action</button>,
    });
    expect(within(screen.getByTestId("chrome-status")).getByText("slot-status")).toBeTruthy();
    expect(within(screen.getByTestId("chrome-actions")).getByRole("button", { name: "slot-action" })).toBeTruthy();
    cleanup();
    renderChrome();
    expect(screen.queryByTestId("chrome-status")).toBeNull();
    expect(screen.queryByTestId("chrome-actions")).toBeNull();
  });
});

describe("Layout app header on /p/*", () => {
  const layoutRoutes = [{
    element: <Layout />,
    children: [
      { index: true, element: <p>home</p> },
      { path: "p/:protoId/cjm", element: <p>proto view</p> },
    ],
  }];

  it("collapses the global header on prototype routes (PrototypeChrome is the only header)", async () => {
    const router = createMemoryRouter(layoutRoutes, { initialEntries: ["/p/demo/cjm"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("proto view")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: appShell.mainNavAria })).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("keeps the global header outside /p/*", async () => {
    const router = createMemoryRouter(layoutRoutes, { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("home")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: appShell.mainNavAria })).toBeTruthy();
    expect(screen.getByRole("link", { name: "API и документация" }).getAttribute("href")).toBe("/api/openapi.json");
  });
});
