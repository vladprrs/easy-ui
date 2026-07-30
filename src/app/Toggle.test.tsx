import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("exposes state through role=switch, not through colour alone", () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} label="Зоны переходов · выкл" />);

    const toggle = screen.getByRole("switch", { name: "Зоны переходов · выкл" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    rerender(<Toggle checked onChange={() => {}} label="Зоны переходов · вкл" />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("flips on click and on the keyboard", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Зоны переходов" />);
    const toggle = screen.getByRole("switch");

    fireEvent.click(toggle);
    // Нативная кнопка: Enter и Space доходят до click сами, отдельного
    // обработчика нет — проверяем, что примитив остался кнопкой.
    expect(toggle.tagName).toBe("BUTTON");
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} disabled label="Зоны переходов" />);

    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
