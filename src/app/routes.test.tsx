import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useBlocker } from "react-router";
import { describe, expect, it } from "vitest";
import { appShell } from "./strings/common";
import { routeObjects } from "./routes";

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
});
