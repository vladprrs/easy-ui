import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectPill } from "./SelectPill";

const versions = [
  { value: "3", label: "Версия 3" },
  { value: "2", label: "Версия 2" },
] as const;

describe("SelectPill", () => {
  it("stays a native select for mobile accessibility", () => {
    render(<SelectPill value="3" onChange={() => {}} options={versions} label="Версия" />);

    const select = screen.getByRole("combobox", { name: "Версия" });
    expect(select.tagName).toBe("SELECT");
    expect((select as HTMLSelectElement).value).toBe("3");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Версия 3", "Версия 2"]);
  });

  it("reports the picked value", () => {
    const onChange = vi.fn();
    render(<SelectPill value="3" onChange={onChange} options={versions} label="Версия" />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("draws the caret as text that never eats the click", () => {
    const { container } = render(<SelectPill value="3" onChange={() => {}} options={versions} label="Версия" />);

    const caret = [...container.querySelectorAll("span")].find((node) => node.textContent === "▾");
    expect(caret).toBeTruthy();
    expect(caret!.className).toContain("pointer-events-none");
    expect(caret!.className).toContain("text-pay-red");
    expect(caret!.getAttribute("aria-hidden")).toBe("true");
  });
});
