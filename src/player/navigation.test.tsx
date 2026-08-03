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

/** Дуо-документ (план multi-surface): КСО (desktop) + приложение (mobile). */
const duoDoc = {
  device: "desktop" as const,
  designSystem: "e2e-starter",
  startScreen: "kso-idle",
  surfaces: [
    { id: "kso", name: "КСО", device: "desktop" as const, startScreen: "kso-idle" },
    { id: "app", name: "Приложение", device: "mobile" as const, startScreen: "app-home" },
  ],
  screens: [
    { id: "kso-idle", surface: "kso" },
    { id: "kso-done", surface: "kso" },
    { id: "app-home", surface: "app" },
    { id: "app-receipt", surface: "app" },
  ],
};

function DuoProbe() {
  const nav = usePlayerNavigation();
  const location = useLocation();
  return <div>
    <output data-testid="path">{location.pathname}</output>
    <output data-testid="search">{location.search}</output>
    <output data-testid="focused">{nav.focusedSurfaceId}</output>
    <output data-testid="map">{JSON.stringify(nav.screenBySurface)}</output>
    <output data-testid="depth">{String(nav.flowDepth)}</output>
    {/* Два navigate в одном событии — разные поверхности (R1-B1b). */}
    <button onClick={() => { nav.navigate("kso-done"); nav.navigate("app-receipt"); }}>pay</button>
    <button onClick={() => nav.navigate("app-receipt")}>open receipt</button>
    <button onClick={() => nav.browseToScreen("kso-done", { app: "app-receipt" })}>guided step</button>
    <button onClick={() => nav.focusSurface("app")}>focus app</button>
    <button onClick={nav.restart}>restart</button>
  </div>;
}

function duoRouterAt(path: string, state?: PlayerLocationState) {
  const [pathname, search] = path.split("?");
  return createMemoryRouter(
    [{
      path: "/p/:protoId/s/:screenId",
      element: <PlayerNavigationProvider startScreen="kso-idle" routeBase="/p/duo" doc={duoDoc}><DuoProbe /></PlayerNavigationProvider>,
    }],
    { initialEntries: [{ pathname, search: search === undefined ? "" : `?${search}`, state }] },
  );
}

describe("player navigation — surfaces (D6)", () => {
  it("two navigate calls in one event update both surfaces", async () => {
    const router = duoRouterAt("/p/duo/s/kso-idle", sessionState());
    render(<RouterProvider router={router} />);
    await act(async () => screen.getByText("pay").click());
    // Path несёт цель последнего перехода (фокус переехал на приложение),
    // query — экран второй поверхности.
    expect(router.state.location.pathname).toBe("/p/duo/s/app-receipt");
    expect(router.state.location.search).toBe("?on.kso=kso-done");
    expect(screen.getByTestId("focused").textContent).toBe("app");
    expect(JSON.parse(screen.getByTestId("map").textContent!)).toEqual({ kso: "kso-done", app: "app-receipt" });
    // flowDepth считается от актуального состояния, а не от React-замыкания.
    expect((router.state.location.state as PlayerLocationState).flowDepth).toBe(2);
  });

  it("restores both panels from history on back", async () => {
    const router = duoRouterAt("/p/duo/s/kso-idle", sessionState());
    render(<RouterProvider router={router} />);
    await act(async () => screen.getByText("pay").click());
    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/p/duo/s/kso-done");
    // Экран по умолчанию в query не пишется: приложение стоит на своём startScreen.
    expect(router.state.location.search).toBe("");
    await act(async () => router.navigate(1));
    expect(router.state.location.pathname).toBe("/p/duo/s/app-receipt");
    expect(JSON.parse(screen.getByTestId("map").textContent!)).toEqual({ kso: "kso-done", app: "app-receipt" });
  });

  it("deep link reads the companion surface from the query", async () => {
    const router = duoRouterAt("/p/duo/s/kso-done?on.app=app-receipt");
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId("focused").textContent).toBe("kso"));
    expect(JSON.parse(screen.getByTestId("map").textContent!)).toEqual({ kso: "kso-done", app: "app-receipt" });
    expect(router.state.location.search).toBe("?on.app=app-receipt");
  });

  it("falls back to startScreen for an unknown or foreign on.* value", async () => {
    const router = duoRouterAt("/p/duo/s/kso-done?on.app=kso-idle&on.gone=x&debug=1");
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId("focused").textContent).toBe("kso"));
    // `kso-idle` принадлежит другой поверхности, `on.gone` — несуществующей: карта
    // нормализуется на startScreen приложения, прочий query сохраняется.
    expect(JSON.parse(screen.getByTestId("map").textContent!)).toEqual({ kso: "kso-done", app: "app-home" });
    expect(router.state.location.search).toBe("?debug=1");
  });

  it("restart resets every surface and clears the map from the query", async () => {
    const router = duoRouterAt("/p/duo/s/kso-idle?debug=1", sessionState());
    render(<RouterProvider router={router} />);
    await act(async () => screen.getByText("pay").click());
    await act(async () => screen.getByText("restart").click());
    expect(router.state.location.pathname).toBe("/p/duo/s/kso-idle");
    expect(router.state.location.search).toBe("?debug=1");
    expect(JSON.parse(screen.getByTestId("map").textContent!)).toEqual({ kso: "kso-idle", app: "app-home" });
  });

  it("guided browse sets both panels with a single replace", async () => {
    const router = duoRouterAt("/p/duo/s/kso-idle", sessionState());
    render(<RouterProvider router={router} />);
    const before = router.state.location.key;
    await act(async () => screen.getByText("guided step").click());
    expect(router.state.location.pathname).toBe("/p/duo/s/kso-done");
    expect(router.state.location.search).toBe("?on.app=app-receipt");
    expect(router.state.location.key).not.toBe(before);
    expect((router.state.location.state as PlayerLocationState).entryReason).toBe("browse");
    // replace: возврат уводит из документа, а не на предыдущий шаг guided browse.
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("focusSurface moves the focus without changing the companion screen", async () => {
    const router = duoRouterAt("/p/duo/s/kso-idle", sessionState());
    render(<RouterProvider router={router} />);
    await act(async () => screen.getByText("focus app").click());
    expect(router.state.location.pathname).toBe("/p/duo/s/app-home");
    expect(router.state.location.search).toBe("");
    expect(screen.getByTestId("focused").textContent).toBe("app");
  });

  it("navigate to a companion screen that is already open still moves the focus", async () => {
    const router = duoRouterAt("/p/duo/s/kso-idle", sessionState());
    render(<RouterProvider router={router} />);
    // app-home уже открыт на второй панели, но фокус стоит на КСО.
    await act(async () => screen.getByText("focus app").click());
    expect(screen.getByTestId("focused").textContent).toBe("app");
    const navigate = vi.spyOn(router, "navigate");
    await act(async () => screen.getByText("open receipt").click());
    expect(navigate).toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/p/duo/s/app-receipt");
  });
});

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
      expect(banner.textContent).toContain("Состояние прототипа сброшено — ссылка вела не на стартовый экран.");
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
