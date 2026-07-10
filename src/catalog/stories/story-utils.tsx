import type { Spec } from "@json-render/core";
import { Renderer } from "@json-render/react";
import { createPlayerRuntime } from "../runtime";

const runtime = createPlayerRuntime({ navigate: () => undefined, back: () => undefined, openUrl: () => undefined, restart: () => undefined });

export function ElementStory({ type, args }: { type: string; args: Record<string, unknown> }) {
  const spec = { root: "demo", elements: { demo: { type, props: args, children: [] } } } as Spec;
  return <Renderer registry={runtime.registry} spec={spec} />;
}

export function SpecStory({ spec }: { spec: Spec }) {
  return <Renderer registry={runtime.registry} spec={spec} />;
}
