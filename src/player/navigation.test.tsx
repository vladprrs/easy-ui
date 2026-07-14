import { act, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { documentLifetimeNonce, FlowResetBanner, PlayerNavigationProvider, usePlayerNavigation, type PlayerLocationState } from "./navigation";

/** Валидный state текущей загрузки документа (W1-5). */
function sessionState(overrides: Partial<PlayerLocationState> = {}): PlayerLocationState {
  return { sessionNonce: "n", flowDepth: 0, entryReason: "flow", documentNonce: documentLifetimeNonce, ...overrides };
}

function Probe() {
  const nav = usePlayerNavigation();
  const location = useLocation();
  return <div>
    <output data-testid="path">{location.pathname}</output>
    <output data-testid="search">{location.search}</output>
    <output data-testid="nonce">{nav.sessionNonce}</output>
    <output data-testid="depth">{String(nav.flowDepth)}</output>
    <output data-testid="reason">{nav.entryReason}</output>
    <FlowResetBanner />
    <button onClick={() => nav.navigate("one")}>same</button>
    <button onClick={() => nav.navigate("two")}>next</button>
    <button onClick={() => nav.browseToScreen("two")}>browse two</button>
    <button onClick={() => nav.browseToScreen("three")}>browse three</button>
    <button onClick={nav.back}>back</button>
    <button onClick={nav.restart}>restart</button>
    <span>{location.pathname.endsWith("/two") ? "old screen content" : "screen content"}</span>
  </div>;
}

function routerAt(path: string, state?: PlayerLocationState, published = false) {
  const routeBase = published ? "/p/a/v/2" : "/p/a";
  const route = published ? "/p/:protoId/v/:version/s/:screenId" : "/p/:protoId/s/:screenId";
  const [pathname, search] = path.split("?");
  return createMemoryRouter(
    [{ path: route, element: <PlayerNavigationProvider startScreen="one" routeBase={routeBase}><Probe /></PlayerNavigationProvider> }],
    { initialEntries: [{ pathname, search: search === undefined ? "" : `?${search}`, state }] },
  );
}

describe("player navigation", () => {
  it("does not navigate to the current screen or back at depth zero", async () => {
    const router = routerAt("/p/a/s/one", sessionState());
    const navigate = vi.spyOn(router, "navigate");
    render(<RouterProvider router={router} />);
    await act(async () => { screen.getByText("same").click(); screen.getByText("back").click(); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("pushes with depth and entryReason=flow and supports guarded back", async () => {
    const router = routerAt("/p/a/s/one", sessionState());
    render(<RouterProvider router={router} />);
    await act(async () => screen.getByText("next").click());
    expect(router.state.location.pathname).toBe("/p/a/s/two");
    expect(router.state.location.state).toEqual(sessionState({ flowDepth: 1 }));
    expect(screen.queryByTestId("flow-reset-banner")).toBeNull();
    await act(async () => screen.getByText("back").click());
    expect(router.state.location.pathname).toBe("/p/a/s/one");
  });

  it("gates a stale entry (history before restart) and replaces it with the session start", async () => {
    const router = routerAt("/p/a/s/one", sessionState({ sessionNonce: "current" }));
    render(<RouterProvider router={router} />);
    await act(async () => router.navigate("/p/a/s/two", { state: sessionState({ sessionNonce: "stale", flowDepth: 4 }) }));
    expect(screen.queryByText("old screen content")).toBeNull();
    expect(router.state.location.pathname).toBe("/p/a/s/one");
    expect(router.state.location.state).toEqual(sessionState({ sessionNonce: "current", entryReason: "bootstrap" }));
  });

  it("restart creates a new nonce and replaces at start", async () => {
    const router = routerAt("/p/a/s/two", sessionState({ sessionNonce: "old", flowDepth: 2 }));
    render(<RouterProvider router={router} />);
    await act(async () => screen.getByText("restart").click());
    expect(router.state.location.pathname).toBe("/p/a/s/one");
    expect((router.state.location.state as PlayerLocationState).sessionNonce).not.toBe("old");
    expect((router.state.location.state as PlayerLocationState).flowDepth).toBe(0);
  });

  it("preserves the published version through bootstrap, navigate, restart, and back", async () => {
    const router = routerAt("/p/a/v/2/s/one", undefined, true);
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/a/v/2/s/one"));
    await act(async () => screen.getByText("next").click());
    expect(router.state.location.pathname).toBe("/p/a/v/2/s/two");
    await act(async () => screen.getByText("back").click());
    expect(router.state.location.pathname).toBe("/p/a/v/2/s/one");
    await act(async () => screen.getByText("restart").click());
    expect(router.state.location.pathname).toBe("/p/a/v/2/s/one");
  });

  describe("entry policy (W1-5)", () => {
    it("treats a restored state with a foreign documentNonce as bootstrap in place", async () => {
      // location.state переживает reload через history.state.usr — документный nonce
      // из прошлой загрузки означает reload; экран сохраняем, стейт сбрасываем.
      const router = routerAt("/p/a/s/two", sessionState({ documentNonce: "previous-document-load", flowDepth: 3 }));
      render(<RouterProvider router={router} />);
      await waitFor(() => expect(screen.getByTestId("reason").textContent).toBe("bootstrap"));
      expect(router.state.location.pathname).toBe("/p/a/s/two");
      const state = router.state.location.state as PlayerLocationState;
      expect(state.documentNonce).toBe(documentLifetimeNonce);
      expect(state.flowDepth).toBe(0);
      expect(screen.getByTestId("flow-reset-banner")).toBeTruthy();
    });

    it("deep link without state stays on the screen and shows the reset banner; restart leads to start", async () => {
      const router = routerAt("/p/a/s/two");
      render(<RouterProvider router={router} />);
      await waitFor(() => expect(screen.getByTestId("reason").textContent).toBe("bootstrap"));
      expect(router.state.location.pathname).toBe("/p/a/s/two");
      const banner = screen.getByTestId("flow-reset-banner");
      await act(async () => banner.querySelector("button")!.click()); // «Начать сначала»
      expect(router.state.location.pathname).toBe("/p/a/s/one");
      expect(screen.queryByTestId("flow-reset-banner")).toBeNull();
    });

    it("bootstrap at the start screen shows no banner", async () => {
      const router = routerAt("/p/a/s/one");
      render(<RouterProvider router={router} />);
      await waitFor(() => expect(screen.getByTestId("reason").textContent).toBe("bootstrap"));
      expect(router.state.location.pathname).toBe("/p/a/s/one");
      expect(screen.queryByTestId("flow-reset-banner")).toBeNull();
    });

    it("the banner is dismissable without navigating", async () => {
      const router = routerAt("/p/a/s/two");
      render(<RouterProvider router={router} />);
      await waitFor(() => expect(screen.getByTestId("flow-reset-banner")).toBeTruthy());
      await act(async () => screen.getByRole("button", { name: "Скрыть уведомление о сбросе" }).click());
      expect(screen.queryByTestId("flow-reset-banner")).toBeNull();
      expect(router.state.location.pathname).toBe("/p/a/s/two");
    });

    it("browseToScreen replaces outside flowDepth with entryReason=browse", async () => {
      const router = routerAt("/p/a/s/one", sessionState());
      render(<RouterProvider router={router} />);
      // flow: one -> two (depth 1), browse: two -> three (replace, depth остаётся 1)
      await act(async () => screen.getByText("next").click());
      await act(async () => screen.getByText("browse three").click());
      expect(router.state.location.pathname).toBe("/p/a/s/three");
      expect(router.state.location.state).toEqual(sessionState({ flowDepth: 1, entryReason: "browse" }));
      expect(screen.getByTestId("depth").textContent).toBe("1");
      expect(screen.queryByTestId("flow-reset-banner")).toBeNull();
      // back с глубины 1 уходит на предыдущую flow-запись (browse-запись replace-нута)
      await act(async () => screen.getByText("back").click());
      expect(router.state.location.pathname).toBe("/p/a/s/one");
    });

    it("browseToScreen at depth zero keeps back disabled semantics", async () => {
      const router = routerAt("/p/a/s/one", sessionState());
      render(<RouterProvider router={router} />);
      await act(async () => screen.getByText("browse two").click());
      expect(router.state.location.pathname).toBe("/p/a/s/two");
      expect(screen.getByTestId("depth").textContent).toBe("0");
      const navigate = vi.spyOn(router, "navigate");
      await act(async () => screen.getByText("back").click());
      expect(navigate).not.toHaveBeenCalled();
    });

    it("preserves the query string through bootstrap, flow, browse, and restart", async () => {
      const router = routerAt("/p/a/s/one?debug=1");
      render(<RouterProvider router={router} />);
      await waitFor(() => expect(screen.getByTestId("reason").textContent).toBe("bootstrap"));
      expect(router.state.location.search).toBe("?debug=1");
      await act(async () => screen.getByText("next").click());
      expect(router.state.location.pathname).toBe("/p/a/s/two");
      expect(router.state.location.search).toBe("?debug=1");
      await act(async () => screen.getByText("browse three").click());
      expect(router.state.location.search).toBe("?debug=1");
      await act(async () => screen.getByText("restart").click());
      expect(router.state.location.pathname).toBe("/p/a/s/one");
      expect(router.state.location.search).toBe("?debug=1");
    });
  });
});
