import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentAuthoringDialog } from "./AgentAuthoringDialog";

describe("AgentAuthoringDialog", () => {
  it("explains the external-agent workflow and closes from the only action", () => {
    const onClose = vi.fn();
    render(<AgentAuthoringDialog onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Соберите прототип с агентом" })).toBeTruthy();
    expect(screen.getByText("Откройте Codex или Claude со скиллом Easy UI и опишите идею. Агент соберёт прототип и добавит его в галерею.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
