import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPlayerRuntime } from "../../runtime";
import { Hotspot } from "./hotspot";
import { hotspotDefinition } from "./hotspot.definition";
import { Image } from "./image";
import { imageDefinition } from "./image.definition";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };
const on = () => ({ shouldPreventDefault: false, bound: false, emit() {} });

describe("host content types", () => {
  it("registers Image and Hotspot for a provider-less design system", () => {
    const registry = createPlayerRuntime(noopDeps, undefined, "custom-only").registry;
    expect(registry.Image).toBeDefined();
    expect(registry.Hotspot).toBeDefined();
    expect(imageDefinition.props.parse({ src: "/images/hero.png", alt: "Hero" })).toEqual({
      src: "/images/hero.png", alt: "Hero", objectFit: "contain",
    });
    expect(hotspotDefinition.props.parse({ x: 1, y: 2, width: 3, height: 4, ariaLabel: "Open" })).toEqual({
      x: 1, y: 2, width: 3, height: 4, ariaLabel: "Open",
    });
  });

  it("renders a neutral flowing img with alt text and object fitting", () => {
    render(<Image props={{ src: "/images/hero.png", alt: "Hero", width: 320, height: 180, objectFit: "cover" }} emit={() => {}} on={on as never} />);
    const image = screen.getByRole("img", { name: "Hero" }) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/images/hero.png");
    expect(image.style.objectFit).toBe("cover");
    expect(image.style.maxWidth).toBe("100%");
  });

  it("keeps Hotspot keyboard-accessible and emits press", () => {
    const emit = vi.fn();
    render(<Hotspot props={{ x: 1, y: 2, width: 30, height: 40, ariaLabel: "Open" }} emit={emit} on={on as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(emit).toHaveBeenCalledWith("press");
  });
});
