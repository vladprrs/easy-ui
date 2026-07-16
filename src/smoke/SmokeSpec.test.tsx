import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlayerRuntimeDeps } from "../catalog/runtime";
import { SmokeRenderer } from "./SmokeSpec";

function createDeps(overrides: Partial<PlayerRuntimeDeps> = {}): PlayerRuntimeDeps {
  return {
    navigate: vi.fn(),
    back: vi.fn(),
    openUrl: vi.fn(),
    restart: vi.fn(),
    ...overrides,
  };
}

describe("debug vertical spike", () => {
  it("renders custom controls with host Image and Hotspot", () => {
    render(<SmokeRenderer deps={createDeps()} />);
    expect(screen.getByRole("button", { name: "Navigate to checkout" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Smoke host image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart prototype" })).toBeTruthy();
  });

  it("keeps conditional custom content hidden initially", () => {
    render(<SmokeRenderer deps={createDeps()} />);
    expect(screen.queryByText("Conditional content is visible")).toBeNull();
  });
});
