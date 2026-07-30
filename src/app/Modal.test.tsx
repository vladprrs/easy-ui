import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmModal, Modal } from "./Modal";

describe("Modal", () => {
  it("labels the dialog by its heading", () => {
    render(<Modal title="Опубликовать версию" onClose={() => {}}><p>тело</p></Modal>);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", { name: "Опубликовать версию" });
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Modal title="Заголовок" onClose={onClose}><button type="button">Действие</button></Modal>);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a backdrop click but not on a panel click", () => {
    const onClose = vi.fn();
    render(<Modal title="Заголовок" onClose={onClose}><p>тело</p></Modal>);

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("focuses the first focusable element, then the panel when there is none", () => {
    const view = render(<Modal title="Заголовок" onClose={() => {}}><button type="button">Первая</button></Modal>);
    expect(document.activeElement?.textContent).toBe("Первая");

    view.unmount();
    render(<Modal title="Заголовок" onClose={() => {}}><p>только текст</p></Modal>);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("traps Tab inside the panel", () => {
    render(<Modal title="Заголовок" onClose={() => {}} footer={<button type="button">Вторая</button>}>
      <button type="button">Первая</button>
    </Modal>);

    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "Первая" });
    const last = screen.getByRole("button", { name: "Вторая" });

    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("returns focus to the trigger it was opened from", () => {
    function Host(): ReactElement {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Открыть</button>
        {open ? <Modal title="Заголовок" onClose={() => setOpen(false)}><p>тело</p></Modal> : null}
      </>;
    }
    render(<Host />);

    const trigger = screen.getByRole("button", { name: "Открыть" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("renders the close glyph only with a label", () => {
    const onClose = vi.fn();
    const view = render(<Modal title="Заголовок" onClose={onClose}><p>тело</p></Modal>);
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();

    view.rerender(<Modal title="Заголовок" closeLabel="Закрыть" onClose={onClose}><p>тело</p></Modal>);
    const close = screen.getByRole("button", { name: "Закрыть" });
    expect(close.textContent).toBe("✕");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ConfirmModal", () => {
  it("wires both actions and shows the consequence", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmModal
      title="Архивировать прототип?"
      body="Прототип пропадёт из галереи, но останется доступен по ссылке."
      confirmLabel="Архивировать"
      cancelLabel="Отмена"
      onConfirm={onConfirm}
      onClose={onClose}
    />);

    expect(screen.getByText("Прототип пропадёт из галереи, но останется доступен по ссылке.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables both actions and swaps the label while busy", () => {
    render(<ConfirmModal
      title="Архивировать прототип?"
      confirmLabel="Архивировать"
      busyLabel="Архивируем…"
      busy
      error="Не удалось"
      cancelLabel="Отмена"
      onConfirm={() => {}}
      onClose={() => {}}
    />);

    expect((screen.getByRole("button", { name: "Архивируем…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Не удалось");
  });
});
