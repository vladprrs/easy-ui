import { z } from "zod";
import { useBoundProp } from "@json-render/react";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import type { ComponentDefinition } from "../catalog/definitions";
import type { EasyUIComponentProps } from "../player/easyUiRuntime";

const names = ["Accordion", "Alert", "Avatar", "Badge", "Box", "Button", "ButtonGroup", "Card", "Carousel", "Checkbox", "Collapsible", "Dialog", "Drawer", "DropdownMenu", "Grid", "Heading", "Input", "Link", "Pagination", "Popover", "Progress", "Radio", "Select", "Separator", "Skeleton", "Slider", "Spinner", "Stack", "Switch", "Table", "Tabs", "Text", "Textarea", "Toggle", "ToggleGroup", "Tooltip"];
const events = ["press", "change", "valueChange", "checkedChange", "select", "openChange"];
const propShapes: Record<string, z.ZodRawShape> = {
  Text: { text: z.string(), variant: z.string().optional() },
  Heading: { text: z.string(), level: z.union([z.string(), z.number()]).optional() },
  Card: { title: z.string().optional(), description: z.string().optional() },
  Stack: { direction: z.string().optional(), gap: z.string().optional() },
  Button: { label: z.string(), disabled: z.boolean().optional(), variant: z.string().optional() },
  Input: { label: z.string().optional(), name: z.string().optional(), value: z.string().optional(), placeholder: z.string().optional() },
  Switch: { label: z.string().optional(), checked: z.boolean().optional() },
};
const definition = (name: string): ComponentDefinition => ({ props: z.looseObject(propShapes[name] ?? {}), description: `Test fixture ${name}`, events, slots: ["default"] });
const Generic = ({ props, children }: EasyUIComponentProps) => <div>{String(props.label ?? props.title ?? props.text ?? "")}{children}</div>;
const components = Object.fromEntries(names.map((name) => [name, Generic])) as unknown as CustomPlayerRuntime["components"];
components.Text = (({ props }: EasyUIComponentProps) => <span>{String(props.text ?? "")}</span>) as unknown as CustomPlayerRuntime["components"][string];
components.Heading = (({ props }: EasyUIComponentProps) => <h1>{String(props.text ?? "")}</h1>) as unknown as CustomPlayerRuntime["components"][string];
components.Card = (({ props, children }: EasyUIComponentProps) => <section><h2>{String(props.title ?? "")}</h2>{children}</section>) as unknown as CustomPlayerRuntime["components"][string];
components.Stack = (({ props, children }: EasyUIComponentProps) => <div className={typeof props.className === "string" ? props.className : undefined}>{children}</div>) as unknown as CustomPlayerRuntime["components"][string];
components.Button = (({ props, on }: EasyUIComponentProps) => <button type="button" disabled={Boolean(props.disabled)} onClick={() => on("press").emit()}>{String(props.label ?? "")}</button>) as unknown as CustomPlayerRuntime["components"][string];
components.Input = (({ props, bindings }: EasyUIComponentProps) => {
  const [value, setValue] = useBoundProp(props.value, bindings?.value);
  return <label>{String(props.label ?? "")}<input value={String(value ?? "")} onChange={(event) => setValue(event.target.value)} /></label>;
}) as unknown as CustomPlayerRuntime["components"][string];
components.Switch = (({ props, bindings }: EasyUIComponentProps) => {
  const [checked, setChecked] = useBoundProp(props.checked, bindings?.checked);
  return <label>{String(props.label ?? "")}<input type="checkbox" checked={Boolean(checked)} onChange={(event) => setChecked(event.target.checked)} /></label>;
}) as unknown as CustomPlayerRuntime["components"][string];

export const legacyTestRuntime: CustomPlayerRuntime = { definitions: Object.fromEntries(names.map((name) => [name, definition(name)])), components };

declare global { var __EUI_LEGACY_TEST_RUNTIME__: CustomPlayerRuntime | undefined; }
