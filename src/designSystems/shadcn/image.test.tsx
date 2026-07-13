import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShadcnProps } from "@json-render/shadcn";
import { ShadcnImage } from "./image";
import { shadcnComponentsWithHotspot, shadcnSystem } from ".";

afterEach(() => { cleanup(); });

type ImageProps = ShadcnProps<"Image">;

function makeElement(props: Partial<ImageProps>) {
  const full: ImageProps = { src: null, alt: "", width: null, height: null, ...props };
  return (
    <ShadcnImage
      props={full}
      emit={vi.fn()}
      on={vi.fn(() => ({ fire: vi.fn(), isBound: false, shouldPreventDefault: false }) as never)}
    />
  );
}

function renderImage(props: Partial<ImageProps>) {
  return render(makeElement(props));
}

function placeholderOf(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[data-testid='image-placeholder']");
}

describe("ShadcnImage wrapper", () => {
  it("renders a plain <img> for a valid src with upstream pixel semantics", () => {
    const { container } = renderImage({ src: "/api/assets/asset_abc", alt: "Диаграмма", width: 320, height: 180 });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/assets/asset_abc");
    expect(img!.getAttribute("alt")).toBe("Диаграмма");
    expect(img!.getAttribute("width")).toBe("320");
    expect(img!.getAttribute("height")).toBe("180");
    expect(img!.className).toBe("rounded max-w-full");
    expect(placeholderOf(container)).toBeNull();
  });

  it("swaps in the placeholder (grey block, icon, alt) when the image fails to load", () => {
    const { container } = renderImage({ src: "/api/assets/asset_missing", alt: "Логотип", width: 200, height: 100 });
    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    const placeholder = placeholderOf(container);
    expect(placeholder).not.toBeNull();
    expect(placeholder!.classList.contains("bg-muted")).toBe(true);
    expect(placeholder!.querySelector("svg")).not.toBeNull();
    expect(placeholder!.textContent).toContain("Логотип");
    expect(placeholder!.getAttribute("role")).toBe("img");
    expect(placeholder!.getAttribute("aria-label")).toBe("Логотип");
    expect(placeholder!.style.width).toBe("200px");
    expect(placeholder!.style.height).toBe("100px");
  });

  it("renders the placeholder for a missing source (null src)", () => {
    const { container } = renderImage({ src: null, alt: "Пусто" });
    expect(container.querySelector("img")).toBeNull();
    const placeholder = placeholderOf(container);
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toContain("Пусто");
    // Upstream fallback dimensions preserved.
    expect(placeholder!.style.width).toBe("80px");
    expect(placeholder!.style.height).toBe("60px");
  });

  it("renders the placeholder for an empty/whitespace src", () => {
    const { container } = renderImage({ src: "   " });
    expect(container.querySelector("img")).toBeNull();
    expect(placeholderOf(container)).not.toBeNull();
  });

  it("omits the alt caption and aria-label when alt is empty", () => {
    const { container } = renderImage({ src: null, alt: "" });
    const placeholder = placeholderOf(container)!;
    expect(placeholder.querySelector("span")).toBeNull();
    expect(placeholder.hasAttribute("aria-label")).toBe(false);
    expect(placeholder.querySelector("svg")).not.toBeNull();
  });

  it("retries the <img> when src changes after a failure", () => {
    const { container, rerender } = renderImage({ src: "/api/assets/broken", alt: "a" });
    fireEvent.error(container.querySelector("img")!);
    expect(placeholderOf(container)).not.toBeNull();

    rerender(makeElement({ src: "/api/assets/fixed", alt: "a" }));
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/assets/fixed");
    expect(placeholderOf(container)).toBeNull();
  });
});

describe("shadcn design system registration", () => {
  it("registers the local wrapper as the Image component", () => {
    expect(shadcnComponentsWithHotspot.Image).toBe(ShadcnImage);
    expect(shadcnSystem.components.Image).toBe(ShadcnImage as never);
  });
});
