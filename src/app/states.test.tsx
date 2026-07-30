import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrandCircles, EmptyState, ErrorState, Skeleton } from "./states";

describe("Skeleton", () => {
  it("announces loading in words and hides the placeholder tiles", () => {
    const { container } = render(<Skeleton label="Загружаем прототипы…" count={3} previewHeight={170} />);

    expect(screen.getByText("Загружаем прототипы…")).toBeTruthy();
    const grid = container.querySelector('[aria-hidden="true"]')!;
    expect(grid.children).toHaveLength(3);
    expect((grid.children[0] as HTMLElement).className).toContain("pay-skeleton");
    expect((grid.children[0]!.firstElementChild as HTMLElement).style.height).toBe("170px");
  });
});

describe("ErrorState", () => {
  it("is an alert with an optional retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState title="API недоступен" />);

    expect(screen.getByRole("alert").textContent).toContain("API недоступен");
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<ErrorState title="API недоступен" retryLabel="Повторить" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("EmptyState", () => {
  it("renders the brand circles plus both action slots", () => {
    const { container } = render(<EmptyState
      title="Пока пусто"
      description="Создайте первый прототип."
      primary={<button type="button">Новый прототип</button>}
      secondary={<button type="button">Импортировать бандл</button>}
    />);

    expect(screen.getByRole("heading", { name: "Пока пусто" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Новый прототип" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Импортировать бандл" })).toBeTruthy();
    expect(container.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(3);
  });

  it("drops the circles where the state lives in a narrow panel", () => {
    const { container } = render(<EmptyState title="Ничего не найдено" circles={false} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

describe("BrandCircles", () => {
  it("is decorative and uses the three brand colours", () => {
    const { container } = render(<BrandCircles />);

    const root = container.firstElementChild!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    const classes = [...root.children].map((node) => node.className);
    expect(classes[0]).toContain("bg-pay-lavender");
    expect(classes[1]).toContain("bg-pay-lavender-light");
    expect(classes[2]).toContain("bg-pay-red");
  });
});
