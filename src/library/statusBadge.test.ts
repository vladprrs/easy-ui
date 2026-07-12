import { describe, expect, it } from "vitest";
import { componentStatusBadge } from "./statusBadge";

describe("componentStatusBadge", () => {
  it("renders no badge for active and lifecycle-internal statuses", () => {
    expect(componentStatusBadge("active")).toBeNull();
    expect(componentStatusBadge("staging")).toBeNull();
    expect(componentStatusBadge("failed")).toBeNull();
  });

  it("renders a coloured badge for the terminal statuses", () => {
    expect(componentStatusBadge("deprecated")).toMatchObject({ label: "Deprecated", title: "Deprecated" });
    expect(componentStatusBadge("superseded")).toMatchObject({ label: "Superseded" });
    expect(componentStatusBadge("rejected")).toMatchObject({ label: "Rejected" });
    expect(componentStatusBadge("archived")).toMatchObject({ label: "Archived" });
  });

  it("carries the reason into the title when provided", () => {
    expect(componentStatusBadge("rejected", "  unsafe code  ")).toMatchObject({ title: "Rejected: unsafe code" });
    expect(componentStatusBadge("deprecated", "   ")?.title).toBe("Deprecated");
  });
});
