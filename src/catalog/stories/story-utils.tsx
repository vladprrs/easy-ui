import type { Spec } from "@json-render/core";
import { Renderer } from "@json-render/react";
import { shadcnAtomicLevels, shadcnLayoutNeutral } from "../../designSystems/shadcn/atomicLevels";
import { wireframeDefinitions } from "../../designSystems/wireframe";
import { createPlayerRuntime } from "../runtime";

const runtimes = new Map<string, ReturnType<typeof createPlayerRuntime>>();

const levelTitles = {
  atom: "Atoms",
  molecule: "Molecules",
  organism: "Organisms",
  template: "Templates",
  page: "Pages",
} as const;

export function titleFor(name: keyof typeof shadcnAtomicLevels) {
  const section = shadcnLayoutNeutral.has(name) ? "Layout" : levelTitles[shadcnAtomicLevels[name]];
  return `Shadcn/${section}/${name}`;
}

export function wireframeTitleFor(name: keyof typeof wireframeDefinitions) {
  const definition = wireframeDefinitions[name];
  const section = "layoutNeutral" in definition && definition.layoutNeutral ? "Layout" : levelTitles[definition.atomicLevel];
  return `Wireframe/${section}/${name}`;
}

function getRuntime(system: string) {
  let runtime = runtimes.get(system);
  if (!runtime) {
    runtime = createPlayerRuntime(
      { navigate: () => undefined, back: () => undefined, openUrl: () => undefined, restart: () => undefined },
      undefined,
      system,
    );
    runtimes.set(system, runtime);
  }
  return runtime;
}

export function ElementStory({ type, args, system = "shadcn" }: { type: string; args: Record<string, unknown>; system?: string }) {
  const runtime = getRuntime(system);
  const spec = { root: "demo", elements: { demo: { type, props: args, children: [] } } } as Spec;
  return <Renderer registry={runtime.registry} spec={spec} />;
}

export function SpecStory({ spec, system = "shadcn" }: { spec: Spec; system?: string }) {
  const runtime = getRuntime(system);
  return <Renderer registry={runtime.registry} spec={spec} />;
}
