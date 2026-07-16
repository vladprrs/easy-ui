import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { share as shareStrings } from "../app/strings/player";
import { ShareDialog } from "./ShareDialog";

const shareApi = vi.hoisted(() => ({
  createPrototypeShare: vi.fn(),
  listPrototypeShares: vi.fn(),
  revokePrototypeShare: vi.fn(),
}));

vi.mock("../api/shareApi", () => shareApi);

const existingGrant = {
  id: "share-existing",
  prototypeId: "prototype-1",
  version: 2,
  createdAt: "2026-07-16T10:00:00.000Z",
  expiresAt: "2026-07-23T10:00:00.000Z",
  activeSessions: 3,
};

const createdGrant = {
  ...existingGrant,
  id: "share-created",
  version: 1,
  url: "https://example.test/share/token",
};

function renderDialog(onClose = vi.fn()) {
  return {
    onClose,
    ...render(<ShareDialog prototypeId="prototype-1" versions={[{ version: 1 }, { version: 2 }]} currentVersion={1} onClose={onClose} />),
  };
}

describe("ShareDialog", () => {
  beforeEach(() => {
    shareApi.createPrototypeShare.mockReset();
    shareApi.listPrototypeShares.mockReset();
    shareApi.revokePrototypeShare.mockReset();
    shareApi.listPrototypeShares.mockResolvedValue({ shares: [] });
    shareApi.revokePrototypeShare.mockResolvedValue(undefined);
  });

  it("loads and shows active grants", async () => {
    shareApi.listPrototypeShares.mockResolvedValue({ shares: [existingGrant] });
    renderDialog();

    expect(await screen.findByText(shareStrings.sessions(3))).toBeTruthy();
    expect(shareApi.listPrototypeShares).toHaveBeenCalledWith("prototype-1", expect.any(AbortSignal));
  });

  it("creates a link with QR and copies its URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    shareApi.createPrototypeShare.mockResolvedValue(createdGrant);
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: shareStrings.create }));

    expect(await screen.findByRole("img", { name: shareStrings.qrLabel })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: shareStrings.createdLabel }) as HTMLInputElement).value).toBe(createdGrant.url);
    expect(shareApi.createPrototypeShare).toHaveBeenCalledWith("prototype-1", 1, 7 * 24 * 60 * 60);

    fireEvent.click(screen.getByRole("button", { name: shareStrings.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(createdGrant.url));
  });

  it("revokes and removes an active grant", async () => {
    shareApi.listPrototypeShares.mockResolvedValue({ shares: [existingGrant] });
    renderDialog();
    await screen.findByText(shareStrings.sessions(3));

    fireEvent.click(screen.getByRole("button", { name: shareStrings.revoke }));

    await waitFor(() => expect(screen.queryByText(shareStrings.sessions(3))).toBeNull());
    expect(screen.getByText(shareStrings.activeEmpty)).toBeTruthy();
    expect(shareApi.revokePrototypeShare).toHaveBeenCalledWith("prototype-1", existingGrant.id);
  });

  it("shows load and create errors", async () => {
    shareApi.listPrototypeShares.mockRejectedValueOnce(new Error("load failed"));
    const first = renderDialog();
    expect((await screen.findByRole("alert")).textContent).toBe(shareStrings.loadError);
    first.unmount();

    shareApi.listPrototypeShares.mockResolvedValueOnce({ shares: [] });
    shareApi.createPrototypeShare.mockRejectedValueOnce(new Error("create failed"));
    renderDialog();
    await screen.findByText(shareStrings.activeEmpty);
    fireEvent.click(screen.getByRole("button", { name: shareStrings.create }));
    expect((await screen.findByRole("alert")).textContent).toBe(shareStrings.createError);
  });

  it("closes through the close button", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: shareStrings.close }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
