import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { useMemo, useState } from "react";
import { createPlayerRuntime, type PlayerRuntimeDeps } from "../catalog/runtime";

export const smokeSpec = {
  root: "card",
  elements: {
    card: {
      type: "Card",
      props: {
        title: "Vertical spike",
        description: "A live json-render spec with state and custom actions",
        maxWidth: "lg",
        centered: true,
        className: null,
      },
      children: ["heading", "input", "switch", "details", "toggle", "greeting", "navigate", "hotspot"],
    },
    heading: { type: "Heading", props: { text: "easy-ui debug", level: "h1" }, children: [] },
    input: {
      type: "Input",
      props: {
        label: "Name",
        name: "name",
        type: "text",
        placeholder: "Ada",
        value: { $bindState: "/name" },
        checks: null,
        validateOn: null,
      },
      children: [],
    },
    switch: {
      type: "Switch",
      props: {
        label: "Show details",
        name: "show-details",
        checked: { $bindState: "/showDetails" },
        checks: null,
        validateOn: null,
      },
      children: [],
    },
    details: {
      type: "Text",
      props: { text: "Conditional content is visible", variant: "default" },
      visible: { $state: "/showDetails" },
      children: [],
    },
    toggle: {
      type: "Button",
      props: { label: "Show details via setState", variant: "primary", disabled: false },
      on: { press: { action: "setState", params: { statePath: "/showDetails", value: true } } },
      children: [],
    },
    greeting: {
      type: "Text",
      props: { text: { $template: "Hello, ${/name}!" }, variant: "muted" },
      children: [],
    },
    navigate: {
      type: "Button",
      props: { label: "Navigate to checkout", variant: "outline", disabled: false },
      on: { press: { action: "navigate", params: { screenId: "checkout" } } },
      children: [],
    },
    hotspot: {
      type: "Hotspot",
      props: { x: 12, y: 12, width: 44, height: 44, ariaLabel: "Restart prototype" },
      on: { press: { action: "restart", params: {} } },
      children: [],
    },
  },
} as Spec;

export function SmokeRenderer({ deps }: { deps: PlayerRuntimeDeps }) {
  const runtime = useMemo(() => createPlayerRuntime(deps), [deps]);
  return (
    <JSONUIProvider
      registry={runtime.registry}
      handlers={runtime.handlers}
      initialState={{ name: "Ada", showDetails: false }}
    >
      <Renderer registry={runtime.registry} spec={smokeSpec} />
    </JSONUIProvider>
  );
}

export function SmokeSpec() {
  const [calls, setCalls] = useState<string[]>([]);
  const deps = useMemo<PlayerRuntimeDeps>(() => ({
    navigate: (screenId) => setCalls((items) => [...items, `navigate:${screenId}`]),
    back: () => setCalls((items) => [...items, "back"]),
    openUrl: (url) => setCalls((items) => [...items, `openUrl:${url}`]),
    restart: () => setCalls((items) => [...items, "restart"]),
  }), []);

  return (
    <main className="mx-auto min-h-screen max-w-3xl p-8">
      <SmokeRenderer deps={deps} />
      <section className="mt-6 rounded-lg border bg-card p-4 shadow-sm" aria-label="Action log">
        <h2 className="font-semibold">Custom action log</h2>
        <output className="mt-2 block font-mono text-sm" aria-live="polite">
          {calls.length ? calls.join("\n") : "No custom actions yet"}
        </output>
      </section>
    </main>
  );
}
