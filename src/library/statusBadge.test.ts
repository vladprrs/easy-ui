import { describe, expect, it } from "vitest";
import { componentStatusBadge } from "./statusBadge";

describe("componentStatusBadge", () => {
  it("renders no badge for active and lifecycle-internal statuses", () => {
    expect(componentStatusBadge("active")).toBeNull();
    expect(componentStatusBadge("staging")).toBeNull();
    expect(componentStatusBadge("failed")).toBeNull();
  });

  it("renders a coloured badge for the terminal statuses", () => {
    expect(componentStatusBadge("deprecated")).toMatchObject({ label: "Устаревший", title: "Устаревший" });
    expect(componentStatusBadge("superseded")).toMatchObject({ label: "Заменён" });
    expect(componentStatusBadge("rejected")).toMatchObject({ label: "Отклонён" });
    expect(componentStatusBadge("archived")).toMatchObject({ label: "В архиве" });
  });

  it("carries the reason into the title when provided", () => {
    expect(componentStatusBadge("rejected", "  unsafe code  ")).toMatchObject({ title: "Отклонён: unsafe code" });
    expect(componentStatusBadge("deprecated", "   ")?.title).toBe("Устаревший");
  });
});
