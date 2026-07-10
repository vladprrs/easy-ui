import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScreenErrorBoundary } from "./ScreenView";

function BrokenRuntimeProp(): never {
  throw new Error("invalid runtime prop");
}

describe("ScreenView error boundary", () => {
  it("shows diagnostics and Restart when runtime rendering fails", () => {
    const restart = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ScreenErrorBoundary prototypeId="broken-prototype" screenId="bad-screen" restart={restart}><BrokenRuntimeProp /></ScreenErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("broken-prototype");
    expect(screen.getByRole("alert").textContent).toContain("bad-screen");
    screen.getByRole("button", { name: "Restart" }).click();
    expect(restart).toHaveBeenCalledOnce();
  });
});
