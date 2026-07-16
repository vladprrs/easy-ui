import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PropsForm, validateZodCandidate, type PropsValidation } from "./PropsForm";

function form(schema: z.ZodType, values: Record<string, unknown>, onCandidate = vi.fn(), validate = (candidate: Record<string, unknown>) => validateZodCandidate(schema, candidate)) {
  return { onCandidate, view: <PropsForm schema={schema} values={values} validate={validate} onCandidate={onCandidate} /> };
}

describe("shared PropsForm core", () => {
  it("accumulates an invalid draft while two required fields are filled", () => {
    const schema = z.strictObject({ first: z.string(), second: z.string() });
    const { view, onCandidate } = form(schema, {});
    render(view);
    fireEvent.change(screen.getByLabelText("first"), { target: { value: "one" } });
    fireEvent.blur(screen.getByLabelText("first"));
    fireEvent.change(screen.getByLabelText("second"), { target: { value: "two" } });
    fireEvent.blur(screen.getByLabelText("second"));
    expect(onCandidate).toHaveBeenNthCalledWith(1, { first: "one" }, expect.objectContaining({ ok: false }));
    expect(onCandidate).toHaveBeenNthCalledWith(2, { first: "one", second: "two" }, { ok: true });
  });

  it("shows defaults only as hints and leaves the raw candidate empty", () => {
    const schema = z.object({
      text: z.string().default("hello"),
      count: z.number().default(3),
      tone: z.enum(["a", "b"]).default("b"),
      enabled: z.boolean().default(true),
    });
    const { view, onCandidate } = form(schema, {});
    render(view);
    expect((screen.getByLabelText("text") as HTMLInputElement).placeholder).toBe("По умолчанию: hello");
    expect((screen.getByLabelText("count") as HTMLInputElement).placeholder).toBe("По умолчанию: 3");
    expect(screen.getByText("По умолчанию: b")).toBeTruthy();
    expect(screen.getByText("По умолчанию: true")).toBeTruthy();
    expect((screen.getByLabelText("tone") as HTMLSelectElement).value).toBe("");
    expect(screen.getAllByText("— не задано —").length).toBeGreaterThanOrEqual(2);
    expect(onCandidate).not.toHaveBeenCalled();
  });

  it("distinguishes optional unset, false, and an empty string", () => {
    const schema = z.object({ enabled: z.boolean().optional(), label: z.string().optional() });
    const { view, onCandidate } = form(schema, {});
    render(view);
    fireEvent.click(screen.getByLabelText("enabled"));
    fireEvent.click(screen.getByLabelText("enabled"));
    fireEvent.change(screen.getByLabelText("label"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("label"));
    expect(onCandidate).toHaveBeenLastCalledWith({ enabled: false, label: "" }, { ok: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Сбросить" })[1]!);
    expect(onCandidate).toHaveBeenLastCalledWith({ enabled: false }, { ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(onCandidate).toHaveBeenLastCalledWith({}, { ok: true });
  });

  it("distinguishes a nullable default, explicit null, and reset", () => {
    const schema = z.object({ label: z.string().nullable().default("hint") });
    const { view, onCandidate } = form(schema, {});
    render(view);
    expect(screen.getByText("По умолчанию: hint")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Установить null" }));
    expect(onCandidate).toHaveBeenLastCalledWith({ label: null }, { ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(onCandidate).toHaveBeenLastCalledWith({}, { ok: true });
  });

  it("maps strict root errors to the form and nested paths to their field", () => {
    const strict = z.strictObject({ label: z.string().optional() });
    const result = validateZodCandidate(strict, { extra: true });
    expect(result).toMatchObject({ ok: false, fields: {}, form: expect.any(String) });
    const nested = validateZodCandidate(z.object({ config: z.object({ count: z.number() }) }), { config: { count: "x" } });
    expect(nested).toMatchObject({ ok: false, fields: { config: expect.any(String) } });
  });

  it("turns a whole-object async refinement into a form error", () => {
    const schema = z.object({ label: z.string() }).refine(async () => true);
    const { view } = form(schema, { label: "x" });
    expect(() => render(view)).not.toThrow();
    expect(screen.getByRole("alert").textContent).toContain("асинхронной валидации");
  });

  it("falls back to whole JSON when field introspection throws", () => {
    const schema = z.object({ value: z.any().refine(async () => true) });
    const validate = (): PropsValidation => ({ ok: true });
    const { view } = form(schema, {}, vi.fn(), validate);
    expect(() => render(view)).not.toThrow();
    expect(screen.getByLabelText("Props (JSON)")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("асинхронной валидации");
  });
});
