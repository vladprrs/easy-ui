import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { createPlayerRuntime, type CustomPlayerRuntime, type PlayerRuntimeDeps } from "../catalog/runtime";
import type { EasyUIComponentProps } from "../player/easyUiRuntime";
import { appShell } from "../app/strings/common";
import { useDocumentTitle } from "../app/useDocumentTitle";

const custom: CustomPlayerRuntime = {
  definitions: {
    SmokeStack: { props: z.strictObject({}), description: "Smoke stack", slots: ["default"] },
    SmokeText: { props: z.strictObject({ text: z.string() }), description: "Smoke text" },
    SmokeButton: { props: z.strictObject({ label: z.string() }), description: "Smoke button", events: ["press"] },
  },
  components: {
    SmokeStack: ({ children }: EasyUIComponentProps) => <div className="space-y-3">{children}</div>,
    SmokeText: ({ props }: EasyUIComponentProps<{ text: string }>) => <p>{props.text}</p>,
    SmokeButton: ({ props, emit }: EasyUIComponentProps<{ label: string }>) => <button type="button" onClick={() => emit("press")}>{props.label}</button>,
  } as unknown as CustomPlayerRuntime["components"],
};

export const smokeSpec = {
  root: "stack",
  elements: {
    stack: { type: "SmokeStack", props: {}, children: ["details", "toggle", "navigate", "image", "hotspot"] },
    details: { type: "SmokeText", props: { text: "Conditional content is visible" }, visible: { $state: "/showDetails" } },
    toggle: { type: "SmokeButton", props: { label: "Show details via setState" }, on: { press: { action: "setState", params: { statePath: "/showDetails", value: true } } } },
    navigate: { type: "SmokeButton", props: { label: "Navigate to checkout" }, on: { press: { action: "navigate", params: { screenId: "checkout" } } } },
    image: { type: "Image", props: { src: "/design/cjm-ui/assets/mascot-laptop.png", alt: "Smoke host image", width: 120, height: 80 } },
    hotspot: { type: "Hotspot", props: { x: 12, y: 12, width: 44, height: 44, ariaLabel: "Restart prototype" }, on: { press: { action: "restart", params: {} } } },
  },
} as Spec;

export function SmokeRenderer({ deps }: { deps: PlayerRuntimeDeps }) {
  const runtime = useMemo(() => createPlayerRuntime(deps, custom, "custom-only"), [deps]);
  return <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} initialState={{ showDetails: false }}><Renderer registry={runtime.registry} spec={smokeSpec} /></JSONUIProvider>;
}

export function SmokeSpec() {
  useDocumentTitle(appShell.navDebug);
  const [calls, setCalls] = useState<string[]>([]);
  const deps = useMemo<PlayerRuntimeDeps>(() => ({
    navigate: (screenId) => setCalls((items) => [...items, `navigate:${screenId}`]), back: () => setCalls((items) => [...items, "back"]), openUrl: (url) => setCalls((items) => [...items, `openUrl:${url}`]), restart: () => setCalls((items) => [...items, "restart"]),
  }), []);
  return <main className="mx-auto max-w-3xl px-6 py-10 sm:px-8"><SmokeRenderer deps={deps} /><output className="mt-8 block font-mono text-sm" aria-live="polite">{calls.length ? calls.join("\n") : "No custom actions yet"}</output></main>;
}
