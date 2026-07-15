import { describe, expect, test } from "bun:test";
import { emitEasyUiRuntimeShim } from "./abi-v2";
import { emitEasyUiRuntimeV3Shim } from "./abi-v3";

async function imported(source: string) {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as Promise<{ token(key: string): string; space(key: string): string }>;
}

describe("runtime shim ABI", () => {
  test("ABI v3 keeps token value semantics and space() embeds a canonical fallback", async () => {
    (globalThis as unknown as { __easyUiShared: { tokens: Record<string, string> } }).__easyUiShared = { tokens: { "color.brand": "red" } };
    const runtime = await imported(emitEasyUiRuntimeV3Shim());
    expect(runtime.token("color.brand")).toBe("red");
    expect(runtime.token("missing")).toBe("");
    expect(runtime.space("md")).toBe("var(--eui-space-md, 12px)");
  });

  test("ABI v2 remains empty-string value lookup with no space helper", async () => {
    (globalThis as unknown as { __easyUiShared: { tokens: Record<string, string> } }).__easyUiShared = { tokens: {} };
    const runtime = await imported(emitEasyUiRuntimeShim());
    expect(runtime.token("missing")).toBe("");
    expect(runtime.space).toBeUndefined();
  });
});
