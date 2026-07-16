import { describe, expect, test } from "bun:test";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import * as zod from "zod";
import * as jsonRenderReact from "@json-render/react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ABI_V1, emitShim, verifyShimAbi, type ShimName } from "./abi-v1";
import { emitEasyUiRuntimeShim } from "./abi-v2";
import { emitEasyUiRuntimeV3Shim } from "./abi-v3";

async function executeFixture(name: string, abi: 1 | 2 | 3) {
  const directory = await mkdtemp(join(tmpdir(), `easy-ui-abi-v${abi}-`));
  let source = await Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
  try {
    for (const shimName of Object.keys(ABI_V1) as ShimName[]) {
      const shimPath = join(directory, `${shimName}.mjs`);
      await Bun.write(shimPath, emitShim(shimName));
      source = source.replaceAll(`/api/shims/v${abi}/${shimName}.js`, pathToFileURL(shimPath).href);
    }
    if (abi === 2) {
      const runtimePath = join(directory, "easy-ui-runtime.mjs");
      await Bun.write(runtimePath, emitEasyUiRuntimeShim());
      source = source.replaceAll("/api/shims/v2/easy-ui-runtime.js", pathToFileURL(runtimePath).href);
    }
    if (abi === 3) {
      const runtimePath = join(directory, "easy-ui-runtime.mjs");
      await Bun.write(runtimePath, emitEasyUiRuntimeV3Shim());
      source = source.replaceAll("/api/shims/v3/easy-ui-runtime.js", pathToFileURL(runtimePath).href);
    }
    const bundlePath = join(directory, name);
    await Bun.write(bundlePath, source);
    return await import(pathToFileURL(bundlePath).href) as { default(props?: Record<string, unknown>): unknown; definition: { description: string } };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("immutable compiled bundle compatibility", () => {
  test("the checked-in ABI v1-v3 bytes execute against current host shims", async () => {
    (globalThis as typeof globalThis & { __easyUiShared: Record<string, unknown> }).__easyUiShared = {
      react: React,
      "react-dom": ReactDOM,
      "react-jsx-runtime": jsxRuntime,
      zod,
      "json-render-react": jsonRenderReact,
      tokens: { "color.brand": "red" },
      icons: {},
    };
    const v1 = await executeFixture("compiled-abi-v1.mjs", 1);
    const v2 = await executeFixture("compiled-abi-v2.mjs", 2);
    const v3 = await executeFixture("compiled-abi-v3.mjs", 3);
    expect(v1.definition.description).toContain("ABI v1");
    expect(v1.default({ label: "legacy" })).toMatchObject({ props: { children: "legacy" } });
    expect(v2.default()).toBe("red");
    expect(v3.default()).toBe("red|var(--eui-space-md, 12px)");
  });

  test("turns any shim export drift warning into a verify failure", async () => {
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { throw new Error(String(message)); };
    try {
      await verifyShimAbi();
    } finally {
      console.warn = originalWarn;
    }
  });
});
