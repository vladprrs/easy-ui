import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPrototypeVersions } from "../api/client";
import { ShareDialog } from "../player/ShareDialog";
import { GalleryShareDialog } from "./GalleryShareDialog";

vi.mock("../api/client", () => ({ listPrototypeVersions: vi.fn() }));
vi.mock("../player/ShareDialog", () => ({
  ShareDialog: vi.fn(({ versions }: { versions: { version: number }[] }) => <div data-testid="share-dialog">{versions.map(({ version }) => `v${version}`).join(", ")}</div>),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("GalleryShareDialog", () => {
  beforeEach(() => {
    vi.mocked(listPrototypeVersions).mockReset();
    vi.mocked(ShareDialog).mockClear();
  });

  it("can be closed while versions are loading", () => {
    vi.mocked(listPrototypeVersions).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<GalleryShareDialog prototypeId="prototype-one" latestVersion={3} onClose={onClose} />);

    expect(screen.getByText("Загружаем версии…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retries after a loading error", async () => {
    vi.mocked(listPrototypeVersions).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([{ version: 3, rev: 7, publishedAt: "2026-07-16T00:00:00.000Z" }]);
    render(<GalleryShareDialog prototypeId="prototype-one" latestVersion={3} onClose={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toBe("Не удалось загрузить версии для ссылки.");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByTestId("share-dialog")).toBeTruthy();
    expect(listPrototypeVersions).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state without mounting ShareDialog", async () => {
    vi.mocked(listPrototypeVersions).mockResolvedValue([]);
    render(<GalleryShareDialog prototypeId="prototype-one" latestVersion={3} onClose={() => {}} />);

    expect(await screen.findByText("Опубликованных версий для ссылки нет.")).toBeTruthy();
    expect(screen.queryByTestId("share-dialog")).toBeNull();
    expect(ShareDialog).not.toHaveBeenCalled();
  });

  it("mounts ShareDialog with loaded versions and the latest version selected", async () => {
    const versions = [
      { version: 3, rev: 7, publishedAt: "2026-07-16T00:00:00.000Z" },
      { version: 2, rev: 5, publishedAt: "2026-07-15T00:00:00.000Z" },
    ];
    vi.mocked(listPrototypeVersions).mockResolvedValue(versions);
    const onClose = vi.fn();
    render(<GalleryShareDialog prototypeId="prototype-one" latestVersion={3} onClose={onClose} />);

    expect((await screen.findByTestId("share-dialog")).textContent).toBe("v3, v2");
    expect(ShareDialog).toHaveBeenCalledWith(expect.objectContaining({
      prototypeId: "prototype-one", versions, currentVersion: 3,
    }), undefined);
  });

  it("aborts the versions request when unmounted", () => {
    const request = deferred<never[]>();
    vi.mocked(listPrototypeVersions).mockReturnValue(request.promise);
    const view = render(<GalleryShareDialog prototypeId="prototype-one" latestVersion={3} onClose={() => {}} />);
    const signal = vi.mocked(listPrototypeVersions).mock.calls[0]![1]!;

    act(() => view.unmount());
    expect(signal.aborted).toBe(true);
  });
});
