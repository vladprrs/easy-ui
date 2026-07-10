import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../app/routes";

vi.mock("../prototype/loader", async () => {
  const hello = (await import("../../prototypes/hello-world.json")).default;
  const other = { ...hello, id: "other", name: "Other", state: { name: "Grace" } };
  return { prototypes: [hello, other], prototypesById: new Map([[hello.id, hello], [other.id, other]]) };
});

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: "*", element: <AppRoutes /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("PlayerShell", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("redirects to start and keeps bound state while screens change", async () => {
    const router = renderAt("/p/hello-world");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/welcome"));
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Lin" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Details" }).at(-1)!);
    await screen.findByText("This is the second screen.");
    fireEvent.click(screen.getAllByRole("button", { name: "Back" }).at(-1)!);
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Lin");
  });

  it("restart and prototype changes create a clean store", async () => {
    const router = renderAt("/p/hello-world/s/welcome");
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Ada");

    await router.navigate("/p/other/s/welcome");
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Grace"));
  });
});
