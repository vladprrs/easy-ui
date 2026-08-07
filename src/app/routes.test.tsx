import { act, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useBlocker, type RouteObject } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMe } from "../api/client";
import { appShell } from "./strings/common";
import { captureRouteObjects, routeObjects } from "./routes";

// Частичный мок: подменяется ровно `getMe` — единственный сетевой след `AuthProvider`, по
// которому и видно, тащит ли маршрут auth-контекст. Остальной клиент остаётся настоящим.
vi.mock("../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getMe: vi.fn(async () => { throw new Error("no session in capture sandbox"); }),
}));

afterEach(() => vi.mocked(getMe).mockClear());

function BlockerProbe() {
  const blocker = useBlocker(true);
  return <p data-testid="blocker-state">{blocker.state}</p>;
}

describe("routeObjects (data router)", () => {
  it("renders the app tree from routeObjects (NotFound inside Layout)", async () => {
    const router = createMemoryRouter(routeObjects, { initialEntries: ["/definitely-missing-route"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: appShell.notFoundTitle })).toBeTruthy();
  });

  it("useBlocker renders in this router tree and blocks navigation (smoke probe)", async () => {
    const router = createMemoryRouter(
      [{ path: "/__blocker-probe", element: <BlockerProbe /> }, ...routeObjects],
      { initialEntries: ["/__blocker-probe"] },
    );
    render(<RouterProvider router={router} />);
    expect((await screen.findByTestId("blocker-state")).textContent).toBe("unblocked");

    await act(() => router.navigate("/definitely-missing-route"));
    expect(screen.getByTestId("blocker-state").textContent).toBe("blocked");
    expect(router.state.location.pathname).toBe("/__blocker-probe");
  });

  /**
   * W10 (план 2026-08-07 §W10, P2.2): сервисная съёмка идёт вторым top-level RouteObject — вне
   * `AuthProvider`. Предмет теста — именно отсутствие auth-контекста в кадре (провайдер дёргал
   * `GET /api/auth/me`, чей отказ приходилось глушить allowlist'ом шума), при неизменном
   * пользовательском роутинге.
   */
  describe("capture-маршруты вне AuthProvider (W10)", () => {
    const captureUrls = ["/capture/proto-1/s/welcome", "/capture/component/widget/draft", "/capture/component/widget/2"];

    it("дерево кадра не поднимает AuthProvider ни на одном capture-маршруте", async () => {
      for (const url of captureUrls) {
        const router = createMemoryRouter(routeObjects, { initialEntries: [url] });
        const view = render(<RouterProvider router={router} />);
        // Поверхность капчура смонтирована (её loading-маркер), а сессия не запрашивалась.
        await waitFor(() => expect(view.container.querySelector("#eui-capture-loading, #eui-capture-surface, #eui-capture-error")).toBeTruthy());
        expect(vi.mocked(getMe)).not.toHaveBeenCalled();
        view.unmount();
      }
    });

    it("обычный маршрут по-прежнему под AuthProvider и спрашивает сессию", async () => {
      const router = createMemoryRouter(routeObjects, { initialEntries: ["/definitely-missing-route"] });
      render(<RouterProvider router={router} />);
      expect(await screen.findByRole("heading", { name: appShell.notFoundTitle })).toBeTruthy();
      await waitFor(() => expect(vi.mocked(getMe)).toHaveBeenCalled());
    });

    it("capture-ветка отделена от auth-ветки и не пересекается с ней путями", () => {
      const [captureBranch, authBranch] = routeObjects;
      expect(routeObjects).toHaveLength(2);
      expect(captureBranch!.element).toBeUndefined();
      expect(captureBranch!.children).toBe(captureRouteObjects);
      const paths = (routes: RouteObject[] | undefined): string[] =>
        (routes ?? []).flatMap((route) => [...(route.path ? [route.path] : []), ...paths(route.children as RouteObject[] | undefined)]);
      expect(paths(captureBranch!.children as RouteObject[]).every((path) => path.startsWith("capture/"))).toBe(true);
      expect(paths(authBranch!.children as RouteObject[]).some((path) => path.startsWith("capture/"))).toBe(false);
    });
  });
});
