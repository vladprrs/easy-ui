import type { Spec } from "@json-render/core";
import { Renderer } from "@json-render/react";
import { useCallback, useMemo, useState } from "react";
import { shadcnAtomicLevels, shadcnLayoutNeutral } from "../../designSystems/shadcn/atomicLevels";
import { wireframeDefinitions } from "../../designSystems/wireframe";
import { SurfaceSpacingScope } from "../../designSystems/SurfaceSpacingScope";
import { splitHostPrimitives } from "../../prototype/runtimeSpec";
import { HostStageSurface } from "../hostPrimitives";
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
  return <StoryRenderer spec={spec} system={system} registry={runtime.registry} />;
}

export function SpecStory({ spec, system = "shadcn" }: { spec: Spec; system?: string }) {
  const runtime = getRuntime(system);
  return <StoryRenderer spec={spec} system={system} registry={runtime.registry} />;
}

function StoryRenderer({ spec, system, registry }: { spec: Spec; system: string; registry: ReturnType<typeof getRuntime>["registry"] }) {
  const split = useMemo(() => splitHostPrimitives({ spec, metadata: {} }), [spec]);
  const hasOverlay = split.hostPrimitives.length > 0;
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const setStageHostRef = useCallback((node: HTMLDivElement | null) => setStageHost(node), []);
  // Preserve the historical naked Renderer path byte-for-byte for ordinary stories.
  if (!hasOverlay) return <Renderer registry={registry} spec={spec} />;
  return <SurfaceSpacingScope systemId={system}>
    <div ref={setStageHostRef} data-eui-stage-viewport="story" style={{ position: "relative", width: 390, height: 844 }}>
      <HostStageSurface stageHostRef={stageHostRef}>
        <>{split.content ? <Renderer registry={registry} spec={split.content.spec} /> : null}{split.hostPrimitives.map((item) => <Renderer registry={registry} spec={item.spec} key={item.spec.root} />)}</>
      </HostStageSurface>
    </div>
  </SurfaceSpacingScope>;
}
