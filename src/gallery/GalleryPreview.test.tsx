import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { GalleryPreviewErrorBoundary } from "./GalleryPreview";

class ThrowPreview extends Component<{ children?: ReactNode }> {
  render(): ReactNode { throw new Error("broken preview"); }
}

describe("GalleryPreviewErrorBoundary", () => {
  it("drops only a failed preview and preserves the metadata card", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<article data-testid="card">
      <h2>Метаданные прототипа</h2>
      <GalleryPreviewErrorBoundary prototypeId="broken"><ThrowPreview /></GalleryPreviewErrorBoundary>
      <p>3 экрана</p>
    </article>);
    expect(screen.getByTestId("card")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Метаданные прототипа" })).toBeTruthy();
    expect(screen.getByText("3 экрана")).toBeTruthy();
    consoleError.mockRestore();
  });
});
