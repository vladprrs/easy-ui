import { describe, expect, test } from "bun:test";
import { emitEasyUiRuntimeShim } from "./abi-v2";
import { emitEasyUiRuntimeV3Shim } from "./abi-v3";
import { emitEasyUiRuntimeV4Shim } from "./abi-v4";

async function imported(source: string) {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as Promise<{
    token(key: string): string;
    space(key: string): string;
    Icon(props: { name: string; size?: number }): unknown;
  }>;
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

/**
 * BR-03 (план 2026-08-08 §3, ревью M14): шим читает `shared`/`React` **в момент вызова**.
 *
 * Реальная поломка выглядела так: модуль шима исполнен до `ensureEasyUiShared()` (порядок импортов
 * материализованного TSX не гарантирован) либо `__easyUiShared` заменён целиком новым объектом —
 * и `Icon` навсегда возвращал `null`, потому что держал снимок пустого globalThis. Именно это и
 * давало «иконки темы не появляются в кадре» при живом реестре.
 */
describe("runtime shim reads host state at call time (BR-03)", () => {
  for (const [abi, emit] of [["v2", emitEasyUiRuntimeShim], ["v3", emitEasyUiRuntimeV3Shim], ["v4", emitEasyUiRuntimeV4Shim]] as const) {
    test(`ABI ${abi}: шим импортирован до появления реестра — Icon рендерится после`, async () => {
      // Момент импорта: хоста нет вовсе — доволновой шим захватил бы здесь `{}` навсегда.
      delete (globalThis as { __easyUiShared?: unknown }).__easyUiShared;
      const runtime = await imported(`${emit()}\n// ${abi}`);
      expect(runtime.Icon({ name: "star" })).toBeNull();
      expect(runtime.token("color.brand")).toBe("");

      // Реестр приезжает позже (тема доехала) — и **новым объектом**, как при замене globalThis.
      const created: { type: unknown; props: Record<string, unknown> }[] = [];
      (globalThis as unknown as { __easyUiShared: unknown }).__easyUiShared = {
        react: { createElement: (type: unknown, props: Record<string, unknown>) => { created.push({ type, props }); return { type, props }; } },
        tokens: { "color.brand": "red" },
        icons: { star: { assetUrl: "/api/assets/asset_star" } },
      };
      expect(runtime.token("color.brand")).toBe("red");
      expect(runtime.Icon({ name: "star", size: 16 })).toMatchObject({ type: "img" });
      expect(created[0]!.props).toMatchObject({ src: "/api/assets/asset_star", "data-eui-icon": "star", width: 16 });
      delete (globalThis as { __easyUiShared?: unknown }).__easyUiShared;
    });
  }
});
