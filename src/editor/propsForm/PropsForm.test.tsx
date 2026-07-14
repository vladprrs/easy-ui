import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getPrototypeDraft } from "../../api/client";
import type { ComponentDefinition } from "../../catalog/definitions";
import { DocEpochContext, PropsForm } from "./PropsForm";

const definition = (props: z.ZodType): ComponentDefinition => ({ description: "test", props });

describe("PropsForm", () => {
  const assetA = `asset_${"a".repeat(64)}`;
  const assetB = `asset_${"b".repeat(64)}`;

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

  it("shows an $asset value in the specialized control without [object Object]", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.object({ icon: z.string() }))} values={{ icon: { $asset: assetA } }} effectiveState={{}} onCommit={onCommit} />);
    expect(screen.getAllByText(assetA)).toHaveLength(2);
    expect(screen.queryByDisplayValue("[object Object]")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "icon" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "URL" }));
    const url = screen.getByRole("textbox", { name: "icon" });
    fireEvent.change(url, { target: { value: "https://example.com/icon.png" } });
    fireEvent.blur(url);
    expect(onCommit).toHaveBeenCalledWith({ icon: "https://example.com/icon.png" });
  });

  it("uploads into $asset and keeps the session-local file in the union list before save", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/draft")) return new Response(JSON.stringify({
        doc: {}, rev: 1, builtinCatalogHash: "", componentManifestHash: "", components: [],
        assets: [{ id: assetA, sha256: "a".repeat(64), mime: "image/png", size: 1024 }],
      }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: assetB, url: `/api/assets/${assetB}`, sha256: "b".repeat(64), mime: "image/webp", size: 2048 }), { status: 201, headers: { "content-type": "application/json" } });
    }));
    await getPrototypeDraft("asset-test");
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.object({ src: z.string() }))} values={{ src: { $asset: assetA } }} effectiveState={{}} onCommit={onCommit} />);
    expect(screen.getByRole("option", { name: new RegExp(assetA) })).toBeTruthy();

    const file = new File(["image"], "hero.webp", { type: "image/webp" });
    fireEvent.change(screen.getByLabelText("Загрузить ассет"), { target: { files: [file] } });

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith({ src: { $asset: assetB } }));
    expect(screen.getByRole("option", { name: /hero\.webp/ })).toBeTruthy();
    const uploadCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/assets");
    expect(uploadCall?.[1]).toEqual(expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
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

  it("resets field drafts when the doc epoch changes and keeps them otherwise (W2-2)", () => {
    const form = (epoch: number) => <DocEpochContext.Provider value={epoch}>
      <PropsForm definition={definition(z.object({ label: z.string() }))} values={{ label: "Base" }} effectiveState={{}} onCommit={() => {}} />
    </DocEpochContext.Provider>;
    const { rerender } = render(form(0));
    const input = screen.getByLabelText("label") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft" } });
    rerender(form(0));
    expect(input.value).toBe("Draft"); // обычный ререндер без смены epoch не трогает черновик
    rerender(form(1));
    expect(input.value).toBe("Base"); // undo/redo (смена epoch) сбрасывает черновик к значению документа
  });

  it("removes an optional number prop when the field is cleared (W2-3: no silent 0)", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.object({ width: z.number().optional() }))} values={{ width: 320 }} effectiveState={{}} onCommit={onCommit} />);
    const input = screen.getByLabelText("width");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith({});
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error and does not commit when a required number field is cleared", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.strictObject({ count: z.number() }))} values={{ count: 1 }} effectiveState={{}} onCommit={onCommit} />);
    const input = screen.getByLabelText("count");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toContain("Поле обязательное — укажите число");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows an error and does not commit non-finite numeric input", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.strictObject({ count: z.number() }))} values={{ count: 1 }} effectiveState={{}} onCommit={onCommit} />);
    const input = screen.getByLabelText("count") as HTMLInputElement;
    // jsdom (как и браузеры) санитизирует невалидный ввод input[type=number] в "" —
    // снимаем type, чтобы дотянуться до NaN-ветки commitNumber напрямую.
    input.type = "text";
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toContain("Введите число");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("offers «не задано» for an optional enum and removes the prop when selected", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.object({ variant: z.enum(["a", "b"]).optional() }))} values={{ variant: "a" }} effectiveState={{}} onCommit={onCommit} />);
    const select = screen.getByLabelText("variant") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "— не задано —" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "" } });
    expect(onCommit).toHaveBeenCalledWith({});
  });

  it("does not offer «не задано» for a required enum", () => {
    render(<PropsForm definition={definition(z.strictObject({ variant: z.enum(["a", "b"]) }))} values={{ variant: "a" }} effectiveState={{}} onCommit={() => {}} />);
    expect(screen.queryByRole("option", { name: "— не задано —" })).toBeNull();
  });

  it("commits an empty required string when the schema allows it, with a warning", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.strictObject({ label: z.string() }))} values={{ label: "x" }} effectiveState={{}} onCommit={onCommit} />);
    const input = screen.getByLabelText("label");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith({ label: "" });
    expect(screen.getByRole("status").textContent).toContain("Обязательное поле пустое");
    fireEvent.change(input, { target: { value: "y" } });
    fireEvent.blur(input);
    expect(screen.queryByRole("status")).toBeNull(); // предупреждение снимается после непустого коммита
  });

  it("shows a validation error (not a warning) for an empty string when minLength forbids it", () => {
    const onCommit = vi.fn();
    render(<PropsForm definition={definition(z.strictObject({ label: z.string().min(1) }))} values={{ label: "x" }} effectiveState={{}} onCommit={onCommit} />);
    const input = screen.getByLabelText("label");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
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
