import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { LibraryPage } from "./LibraryPage";

vi.mock("./storybookIndex", () => ({ fetchStorybookIndex: vi.fn().mockResolvedValue(null) }));

describe("LibraryPage", () => {
  it("shows startup instructions when Storybook is unavailable", async () => {
    const router = createMemoryRouter([{ path: "/library", element: <LibraryPage /> }], { initialEntries: ["/library"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText(/npm run storybook/)).toBeTruthy();
    expect(screen.getByText(/Storybook is unavailable/)).toBeTruthy();
  });
});
