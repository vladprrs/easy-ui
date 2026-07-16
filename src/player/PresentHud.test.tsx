import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresentHud, type PresentHudProps } from "./PresentHud";

const navigation = { restart: vi.fn() };

function HudHarness({ initialOpen = false, ...props }: Omit<PresentHudProps, "open" | "onOpenChange"> & { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <PresentHud {...props} open={open} onOpenChange={setOpen} />;
}

function renderHud(overrides: Partial<React.ComponentProps<typeof HudHarness>> = {}) {
  return render(<MemoryRouter><HudHarness
    navigation={navigation}
    current={2}
    total={3}
    exitPath="/p/demo/s/details"
    directEntry
    share={false}
    {...overrides}
  /></MemoryRouter>);
}

describe("PresentHud", () => {
  afterEach(() => {
    vi.useRealTimers();
    navigation.restart.mockReset();
  });

  it("opens from the FAB and auto-closes after four idle seconds, resetting on interaction", () => {
    vi.useFakeTimers();
    renderHud();

    fireEvent.click(screen.getByRole("button", { name: "Открыть управление презентацией" }));
    const panel = screen.getByRole("dialog", { name: "Управление презентацией" });
    act(() => vi.advanceTimersByTime(3_999));
    expect(panel).toBeTruthy();

    fireEvent.pointerDown(panel);
    act(() => vi.advanceTimersByTime(3_999));
    expect(screen.getByRole("dialog", { name: "Управление презентацией" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("dialog", { name: "Управление презентацией" })).toBeNull();
  });

  it("shows the exit for both workspace entry modes and never for share", () => {
    const direct = renderHud({ initialOpen: true, directEntry: true });
    expect(screen.getByRole("link", { name: "Открыть в easy-ui" }).getAttribute("href")).toBe("/p/demo/s/details");
    direct.unmount();

    const internal = renderHud({ initialOpen: true, directEntry: false });
    expect(screen.getByRole("link", { name: "Вернуться в плеер" }).getAttribute("href")).toBe("/p/demo/s/details");
    internal.unmount();

    renderHud({ initialOpen: true, share: true });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("restarts through player navigation", () => {
    renderHud({ initialOpen: true });
    fireEvent.click(screen.getByRole("button", { name: "Начать сначала" }));
    expect(navigation.restart).toHaveBeenCalledOnce();
  });

  it("keeps the HUD transparent outside its z-40 interactive nodes", () => {
    renderHud();
    const wrapper = screen.getByTestId("present-hud");
    const fab = screen.getByRole("button", { name: "Открыть управление презентацией" });
    expect(wrapper.classList.contains("pointer-events-none")).toBe(true);
    expect(fab.classList.contains("pointer-events-auto")).toBe(true);
    expect(fab.classList.contains("z-40")).toBe(true);

    fireEvent.click(fab);
    const panel = screen.getByRole("dialog", { name: "Управление презентацией" });
    expect(panel.classList.contains("pointer-events-auto")).toBe(true);
    expect(panel.classList.contains("z-40")).toBe(true);
    expect(panel.classList.contains("z-50")).toBe(false);
  });
});
