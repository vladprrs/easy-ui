import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMe, loginRedirectForLocation, validateNextPath } from "./client";

const unauthorized = () => Promise.resolve(new Response(JSON.stringify({
  error: { code: "unauthorized", message: "Authentication required" },
}), { status: 401, headers: { "content-type": "application/json" } }));

function locationAt(pathname: string, search = "", hash = "") {
  return { origin: "http://localhost", pathname, search, hash, assign: vi.fn() };
}

describe("auth redirect on 401", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(unauthorized)));
  afterEach(() => vi.unstubAllGlobals());

  it("redirects an application route to login and preserves the full relative path", async () => {
    const location = locationAt("/library", "?section=atoms", "#button");
    vi.stubGlobal("location", location);

    await expect(getMe()).rejects.toMatchObject({ status: 401 });

    expect(location.assign).toHaveBeenCalledWith("/login?next=%2Flibrary%3Fsection%3Datoms%23button");
  });

  it.each(["/share/token", "/share/p/demo/v/1/present"])("does not redirect a share route: %s", async (pathname) => {
    const location = locationAt(pathname);
    vi.stubGlobal("location", location);

    await expect(getMe()).rejects.toMatchObject({ status: 401 });

    expect(location.assign).not.toHaveBeenCalled();
  });

  it("does not redirect the login page", () => {
    expect(loginRedirectForLocation(locationAt("/login"))).toBeNull();
  });
});

describe("validateNextPath", () => {
  it.each([
    ["/library?tab=mine#top", "/library?tab=mine#top"],
    ["/a/../users", "/users"],
  ])("accepts and normalizes a same-origin relative path", (input, expected) => {
    expect(validateNextPath(input, "https://easy-ui.example")).toBe(expected);
  });

  it.each(["https://evil.example/path", "//evil.example/path", "/\\evil", "library", ""])("rejects an unsafe next value: %s", (input) => {
    expect(validateNextPath(input, "https://easy-ui.example")).toBeNull();
  });
});
