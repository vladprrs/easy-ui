import type { ComponentRenderer, ComponentRenderProps, ComponentRegistry } from "@json-render/react";

type StaticProps = ComponentRenderProps<Record<string, unknown>>;

const StaticClosedDialog: ComponentRenderer<Record<string, unknown>> = () => null;
const StaticTooltip: ComponentRenderer<Record<string, unknown>> = ({ element }: StaticProps) =>
  <span className="text-sm underline decoration-dotted">{String(element.props.text ?? "")}</span>;
const StaticPopover: ComponentRenderer<Record<string, unknown>> = ({ element }: StaticProps) =>
  <span className="inline-flex rounded-md border px-3 py-2 text-sm">{String(element.props.trigger ?? "")}</span>;
const StaticSelect: ComponentRenderer<Record<string, unknown>> = ({ element }: StaticProps) =>
  <div className="space-y-2"><span className="block text-sm font-medium">{String(element.props.label ?? "")}</span><span className="block rounded-md border px-3 py-2 text-sm text-muted-foreground">{String(element.props.placeholder ?? element.props.value ?? "")}</span></div>;
const StaticDropdownMenu: ComponentRenderer<Record<string, unknown>> = ({ element }: StaticProps) =>
  <span className="inline-flex rounded-md border px-3 py-2 text-sm">{String(element.props.label ?? "")}</span>;

export function createCjmRegistry(registry: ComponentRegistry): ComponentRegistry {
  // The shadcn system is the only built-in system with portal primitives.
  // Wireframe has a native Select and must retain its original renderer.
  if (!("Dialog" in registry)) return { ...registry };
  return {
    ...registry,
    Dialog: StaticClosedDialog,
    Drawer: StaticClosedDialog,
    Select: StaticSelect,
    Popover: StaticPopover,
    DropdownMenu: StaticDropdownMenu,
    Tooltip: StaticTooltip,
  };
}
