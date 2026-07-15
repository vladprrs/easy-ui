// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SurfaceSpacingScope } from "./SurfaceSpacingScope";

describe("SurfaceSpacingScope", () => {
  it("owns all nine variables on each stage root without cross-surface leakage", () => {
    const { container } = render(<>
      <SurfaceSpacingScope systemId="custom" themeTokens={{ "space.md": "14px" }}><div data-stage="a" /></SurfaceSpacingScope>
      <SurfaceSpacingScope systemId="custom" themeTokens={{ "space.md": "15px" }}><div data-stage="b" /></SurfaceSpacingScope>
    </>);
    const a = container.querySelector<HTMLElement>('[data-stage="a"]')!;
    const b = container.querySelector<HTMLElement>('[data-stage="b"]')!;
    expect(a.style.getPropertyValue("--eui-space-md")).toBe("14px");
    expect(b.style.getPropertyValue("--eui-space-md")).toBe("15px");
    expect(Array.from({ length: a.style.length }, (_, index) => a.style.item(index)).filter((name) => name.startsWith("--eui-space-"))).toHaveLength(9);
  });
});
