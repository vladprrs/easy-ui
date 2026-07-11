import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { fetchStorybookIndex } from "./storybookIndex";
import { LibraryPage } from "./LibraryPage";

vi.mock("./storybookIndex", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storybookIndex")>();
  return { ...original, fetchStorybookIndex: vi.fn() };
});

function renderLibrary() {
  const router = createMemoryRouter([{ path: "/library", element: <LibraryPage /> }], { initialEntries: ["/library"] });
  render(<RouterProvider router={router} />);
}

describe("LibraryPage", () => {
  it("shows startup instructions when Storybook is unavailable", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue(null);
    renderLibrary();
    expect(await screen.findByText(/npm run storybook/)).toBeTruthy();
    expect(screen.getByText(/Storybook is unavailable/)).toBeTruthy();
  });

  it("switches sorted systems, groups known levels, and falls back to Other", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue({ entries: {
      wire: { id: "wire", title: "Wireframe/Atoms/Input", name: "Default", type: "story" },
      page: { id: "page", title: "Shadcn/Pages/Dashboard", name: "Default", type: "story" },
      atom: { id: "atom", title: "Shadcn/Atoms/Button", name: "Default", type: "story" },
      odd: { id: "odd", title: "Shadcn/Legacy", name: "Legacy story", type: "story" },
    } });
    renderLibrary();

    const switcher = await screen.findByLabelText("Design systems");
    expect(within(switcher).getAllByRole("button").map((button) => button.textContent)).toEqual(["Shadcn", "Wireframe"]);
    expect(within(switcher).getByRole("button", { name: "Shadcn" }).getAttribute("aria-pressed")).toBe("true");
    const navigation = screen.getByRole("navigation", { name: "Stories" });
    expect(within(navigation).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Atoms", "Pages", "Other"]);
    expect(within(navigation).getByRole("button", { name: "Button" })).toBeTruthy();
    expect(within(navigation).getByRole("button", { name: "Legacy story" })).toBeTruthy();

    fireEvent.click(within(switcher).getByRole("button", { name: "Wireframe" }));
    expect(within(navigation).getByRole("button", { name: "Input" })).toBeTruthy();
    expect(within(navigation).queryByRole("button", { name: "Button" })).toBeNull();
    expect(screen.getByTitle("Story preview").getAttribute("src")).toContain("id=wire");
  });
});
