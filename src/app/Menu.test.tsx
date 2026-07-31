import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Menu, MenuItem, MenuSeparator, MenuSubmenu, useMenuClose } from "./Menu";

const openMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Действия" }));
  return screen.getByRole("menu");
};

function Sample({ onOpenChange, onSelect }: { onOpenChange?: (open: boolean) => void; onSelect?: () => void } = {}) {
  return <Menu label="Действия" onOpenChange={onOpenChange}>
    <MenuItem onSelect={onSelect}>Плеер</MenuItem>
    <MenuItem disabled>Редактор</MenuItem>
    <MenuSeparator />
    <MenuItem destructive>Архивировать</MenuItem>
  </Menu>;
}

describe("Menu", () => {
  it("exposes the popover contract on the trigger", () => {
    render(<Sample />);
    const trigger = screen.getByRole("button", { name: "Действия" });

    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu").id).toBe(trigger.getAttribute("aria-controls"));
  });

  it("reports open state to the host (player hotkey guard)", () => {
    const onOpenChange = vi.fn();
    render(<Sample onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Действия" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Действия" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("moves through enabled items with the arrow keys and wraps around", () => {
    render(<Sample />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Плеер");
    // Отключённый «Редактор» из обхода выпадает.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Архивировать");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Плеер");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("Архивировать");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement?.textContent).toBe("Плеер");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Архивировать");
  });

  it("opens with ArrowDown from the trigger and lands on the first item", () => {
    render(<Sample />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Действия" }), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Плеер");
  });

  it("activates an item with Enter", () => {
    const onSelect = vi.fn();
    render(<Sample onSelect={onSelect} />);
    openMenu();

    // Пункт — нативная кнопка, поэтому Enter доходит до click сам.
    fireEvent.click(screen.getByRole("menuitem", { name: "Плеер" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<Sample />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Действия" }));
  });

  it("closes on a click outside but not inside", () => {
    render(<Sample />);
    const menu = openMenu();

    fireEvent.pointerDown(menu);
    expect(screen.queryByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the menu mounted while a mutation is locked", () => {
    render(<Menu label="Действия" locked><MenuItem>Плеер</MenuItem></Menu>);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeTruthy();
  });

  // Императивное закрытие: до него потребители закрывали поповер пересозданием
  // `Menu` через `key` — при этом `onOpenChange(false)` не приходил вовсе, а фокус
  // приходилось возвращать на триггер вручную, из layout-эффекта на смену ключа.
  it("reports the close and returns focus when an item closes the menu itself", () => {
    const onOpenChange = vi.fn();
    function CloseItem() {
      const close = useMenuClose();
      return <MenuItem onSelect={close}>Выбрать сценарий</MenuItem>;
    }
    render(<Menu label="Действия" onOpenChange={onOpenChange}><CloseItem /></Menu>);
    openMenu();
    onOpenChange.mockClear();

    fireEvent.click(screen.getByRole("menuitem", { name: "Выбрать сценарий" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Действия" }));
  });

  it("closes from a nested item through the context and only when asked", () => {
    function ContextItem({ label }: { label: string }) {
      const close = useMenuClose();
      return <button type="button" role="menuitem" onClick={close}>{label}</button>;
    }
    render(<Menu label="Действия">
      <MenuItem>Тумблер</MenuItem>
      <ContextItem label="Уйти" />
    </Menu>);
    openMenu();

    // Обычный пункт поповер не закрывает — среди пунктов бывают тумблеры.
    fireEvent.click(screen.getByRole("menuitem", { name: "Тумблер" }));
    expect(screen.queryByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Уйти" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes after selecting an item that asked for it", () => {
    render(<Menu label="Действия"><MenuItem closeOnSelect>Опубликовать</MenuItem></Menu>);
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Опубликовать" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("swaps the submenu glyph instead of rotating it and folds its items into the roving order", () => {
    const onOpen = vi.fn();
    render(<Menu label="Действия">
      <MenuItem>Плеер</MenuItem>
      <MenuSubmenu label="Версии" onOpen={onOpen}><MenuItem>v3</MenuItem></MenuSubmenu>
    </Menu>);
    const menu = openMenu();

    const submenu = screen.getByRole("menuitem", { name: /Версии/ });
    expect(submenu.getAttribute("aria-expanded")).toBe("false");
    expect(submenu.textContent).toContain("▸");

    fireEvent.click(submenu);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(submenu.getAttribute("aria-expanded")).toBe("true");
    expect(submenu.textContent).toContain("▾");
    expect(submenu.className).not.toContain("rotate");

    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement?.textContent).toBe("v3");
  });
});
