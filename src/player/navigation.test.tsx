import { act, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { PlayerNavigationProvider, usePlayerNavigation, type PlayerLocationState } from "./navigation";

function Probe() {
  const nav = usePlayerNavigation();
  const location = useLocation();
  return <div>
    <output data-testid="path">{location.pathname}</output>
    <output data-testid="nonce">{nav.sessionNonce}</output>
    <button onClick={() => nav.navigate("one")}>same</button>
    <button onClick={() => nav.navigate("two")}>next</button>
    <button onClick={nav.back}>back</button>
    <button onClick={nav.restart}>restart</button>
    <span>{location.pathname.endsWith("/two") ? "old screen content" : "screen content"}</span>
  </div>;
}

function routerAt(path: string, state?: PlayerLocationState, published = false) {
  const routeBase = published ? "/p/a/v/2" : "/p/a";
  const route = published ? "/p/:protoId/v/:version/s/:screenId" : "/p/:protoId/s/:screenId";
  return createMemoryRouter([{ path: route, element: <PlayerNavigationProvider startScreen="one" routeBase={routeBase}><Probe /></PlayerNavigationProvider> }], { initialEntries: [{ pathname: path, state }] });
}

describe("player navigation", () => {
  it("does not navigate to the current screen or back at depth zero", async () => {
    const router = routerAt("/p/a/s/one", { sessionNonce: "n", flowDepth: 0 });
    const navigate = vi.spyOn(router, "navigate");
    render(<RouterProvider router={router} />);
    await act(async () => { screen.getByText("same").click(); screen.getByText("back").click(); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("pushes with depth and supports guarded back", async () => {
    const router = routerAt("/p/a/s/one", { sessionNonce: "n", flowDepth: 0 });
    render(<RouterProvider router={router} />);
    await act(async () => screen.getByText("next").click());
    expect(router.state.location.pathname).toBe("/p/a/s/two");
    expect(router.state.location.state).toEqual({ sessionNonce: "n", flowDepth: 1 });
    await act(async () => screen.getByText("back").click());
    expect(router.state.location.pathname).toBe("/p/a/s/one");
  });

  it("gates a stale entry and replaces it with the session start", async () => {
    const router = routerAt("/p/a/s/one", { sessionNonce: "current", flowDepth: 0 });
    render(<RouterProvider router={router} />);
    await act(async () => router.navigate("/p/a/s/two", { state: { sessionNonce: "stale", flowDepth: 4 } }));
    expect(screen.queryByText("old screen content")).toBeNull();
    expect(router.state.location.pathname).toBe("/p/a/s/one");
    expect(router.state.location.state).toEqual({ sessionNonce: "current", flowDepth: 0 });
  });

  it("restart creates a new nonce and replaces at start", async () => {
    const router = routerAt("/p/a/s/two", { sessionNonce: "old", flowDepth: 2 });
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
});
