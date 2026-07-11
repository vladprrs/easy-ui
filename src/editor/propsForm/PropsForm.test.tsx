import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ComponentDefinition } from "../../catalog/definitions";
import { PropsForm } from "./PropsForm";

const definition = (props: z.ZodType): ComponentDefinition => ({ description: "test", props });

describe("PropsForm", () => {
  it("commits the complete candidate and validates dynamic paths against effective state", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.strictObject({ label: z.string(), count: z.number() }))} values={{ label: { $state: "/profile/name" }, count: 1 }} effectiveState={{ profile: { name: "Ada" } }} onCommit={onCommit} />);
    const count = screen.getByLabelText("count");
    fireEvent.change(count, { target: { value: "2" } });
    fireEvent.blur(count);
    expect(onCommit).toHaveBeenCalledWith({ label: { $state: "/profile/name" }, count: 2 });
  });

  it("uses a JSON textarea for a dynamic scalar value", () => {
    render(<PropsForm definition={definition(z.object({ label: z.string() }))} values={{ label: { $state: "/label" } }} effectiveState={{ label: "Hello" }} onCommit={() => {}} />);
    expect(screen.getByText("динамическое значение")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "label" }).tagName).toBe("TEXTAREA");
  });

  it("does not commit invalid JSON", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.object({ config: z.record(z.string(), z.string()) }))} values={{ config: { old: "value" } }} effectiveState={{}} onCommit={onCommit} />);
    const textarea = screen.getByRole("textbox", { name: "config" });
    fireEvent.change(textarea, { target: { value: "{" } });
    fireEvent.blur(textarea);
    expect(screen.getByRole("alert").textContent).toContain("Некорректный JSON");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("edits and stores the input side of a ZodPipe", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.object({ amount: z.string().pipe(z.coerce.number()) }))} values={{ amount: "12" }} effectiveState={{}} onCommit={onCommit} />);
    const input = screen.getByLabelText("amount");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith({ amount: "42" });
  });
});
