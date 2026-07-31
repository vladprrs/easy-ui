import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPrototypeVersions } from "../api/client";
import { share as shareStrings } from "../app/strings/player";
import { GalleryShareDialog } from "./GalleryShareDialog";

vi.mock("../api/client", () => ({ listPrototypeVersions: vi.fn() }));
const shareApi = vi.hoisted(() => ({
  createPrototypeShare: vi.fn(),
  listPrototypeShares: vi.fn(),
  revokePrototypeShare: vi.fn(),
}));
vi.mock("../api/shareApi", () => shareApi);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const renderDialog = (onClose = () => {}) => render(<MemoryRouter>
  <GalleryShareDialog prototypeId="prototype-one" latestVersion={3} onClose={onClose} />
</MemoryRouter>);

// Окно одно на все состояния списка версий (план W6 §2): раньше загрузка жила в
// отдельной узкой панели, которая подменялась широким диалогом — окно прыгало.
describe("GalleryShareDialog", () => {
  beforeEach(() => {
    vi.mocked(listPrototypeVersions).mockReset();
    shareApi.listPrototypeShares.mockReset();
    shareApi.listPrototypeShares.mockResolvedValue({ shares: [] });
  });

  it("keeps one dialog body while versions are loading and can be closed", () => {
    vi.mocked(listPrototypeVersions).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    renderDialog(onClose);

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: shareStrings.dialogTitle })).toBeTruthy();
    expect(screen.getByText(shareStrings.versionsLoading)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: shareStrings.close }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retries after a loading error inside the same dialog", async () => {
    vi.mocked(listPrototypeVersions)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([{ version: 3, rev: 7, publishedAt: "2026-07-16T00:00:00.000Z" }]);
    renderDialog();

    expect((await screen.findByRole("alert")).textContent).toBe(shareStrings.versionsLoadFailed);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("button", { name: shareStrings.create })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(listPrototypeVersions).toHaveBeenCalledTimes(2);
  });

  it("offers publishing a version instead of dead-ending on the empty state", async () => {
    vi.mocked(listPrototypeVersions).mockResolvedValue([]);
    renderDialog();

    expect(await screen.findByText(shareStrings.versionsEmpty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: shareStrings.create })).toBeNull();
    expect(screen.getByRole("link", { name: shareStrings.versionsPublishCta }).getAttribute("href")).toBe("/p/prototype-one/edit");
  });

  it("selects the latest published version once the list arrives", async () => {
    vi.mocked(listPrototypeVersions).mockResolvedValue([
      { version: 3, rev: 7, publishedAt: "2026-07-16T00:00:00.000Z" },
      { version: 2, rev: 5, publishedAt: "2026-07-15T00:00:00.000Z" },
    ]);
    renderDialog();

    const select = await screen.findByLabelText(shareStrings.version) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["v3", "v2"]);
    expect(select.value).toBe("3");
  });

  it("aborts the versions request when unmounted", () => {
    const request = deferred<never[]>();
    vi.mocked(listPrototypeVersions).mockReturnValue(request.promise);
    const view = renderDialog();
    const signal = vi.mocked(listPrototypeVersions).mock.calls[0]![1]!;

    act(() => view.unmount());
    expect(signal.aborted).toBe(true);
  });
});
