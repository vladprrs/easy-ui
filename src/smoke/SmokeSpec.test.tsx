import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("dispatches a custom action from a Button", async () => {
    const navigate = vi.fn();
    render(<SmokeRenderer deps={createDeps({ navigate })} />);
    fireEvent.click(screen.getByRole("button", { name: "Navigate to checkout" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("checkout"));
  });

  it("re-renders a visible element after setState", async () => {
    render(<SmokeRenderer deps={createDeps()} />);
    expect(screen.queryByText("Conditional content is visible")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details via setState" }));
    expect(await screen.findByText("Conditional content is visible")).not.toBeNull();
  });
});
