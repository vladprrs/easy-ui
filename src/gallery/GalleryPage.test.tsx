import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { GalleryPage } from "./GalleryPage";

vi.mock("../prototype/loader", async () => {
  const hello = (await import("../../prototypes/hello-world.json")).default;
  return { prototypes: [hello], prototypesById: new Map([[hello.id, hello]]) };
});

describe("GalleryPage", () => {
  it("renders the hello-world card and links to the player bootstrap route", () => {
    const router = createMemoryRouter([{ path: "/", element: <GalleryPage /> }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    expect(screen.getByRole("heading", { name: "Hello World" })).toBeTruthy();
    expect(screen.getByText("A minimal two-screen prototype.")).toBeTruthy();
    expect(screen.getByText("Mobile")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Hello World/ }).getAttribute("href")).toBe("/p/hello-world");
  });
});
