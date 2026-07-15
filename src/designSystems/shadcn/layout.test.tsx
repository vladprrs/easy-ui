// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shadcnComponentsWithHotspot, componentDefinitions } from ".";
import { shadcnSpacingScale } from "../spacingScale";

afterEach(cleanup);

describe("shadcn spacing layout", () => {
  it("declares Stack flow and Grid spacing without changing upstream enum subsets", () => {
    expect(componentDefinitions.Stack.layout).toEqual({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: { prop: "direction", vertical: ["vertical"], horizontal: ["horizontal"] } } });
    expect(componentDefinitions.Grid.layout).toEqual({ version: 1, spacing: ["gap"] });
    expect(componentDefinitions.Stack.props.safeParse({ gap: "2xl" }).success).toBe(false);
    expect(componentDefinitions.Grid.props.safeParse({ gap: "none" }).success).toBe(false);
  });

  it("snapshots the explicit px table against actual upstream Tailwind classes", () => {
    const Stack = shadcnComponentsWithHotspot.Stack;
    const rows = (["none", "sm", "md", "lg", "xl"] as const).map((gap) => {
      const { container, unmount } = render(<Stack props={{ direction: "vertical", gap, align: null, justify: null, className: null }} emit={vi.fn()} on={vi.fn() as never}>x</Stack>);
      const className = container.firstElementChild!.className;
      unmount();
      return { token: gap, px: shadcnSpacingScale[gap], className: className.match(/gap-[0-9]+/)?.[0] };
    });
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "className": "gap-0",
          "px": "0px",
          "token": "none",
        },
        {
          "className": "gap-2",
          "px": "8px",
          "token": "sm",
        },
        {
          "className": "gap-3",
          "px": "12px",
          "token": "md",
        },
        {
          "className": "gap-4",
          "px": "16px",
          "token": "lg",
        },
        {
          "className": "gap-6",
          "px": "24px",
          "token": "xl",
        },
      ]
    `);
  });
});
