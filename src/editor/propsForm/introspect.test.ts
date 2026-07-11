import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDesignSystem } from "../../designSystems";
import { describePropsSchema } from "./introspect";

describe("describePropsSchema", () => {
  it("describes scalar controls, literal unions, wrappers, defaults, and pipe inputs", () => {
    const fields = describePropsSchema(z.object({
      text: z.string(),
      choice: z.enum(["a", "b"]),
      numbers: z.union([z.literal(1), z.literal(2)]),
      literal: z.literal("only"),
      enabled: z.boolean(),
      amount: z.number(),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
      defaulted: z.string().default("value"),
      readonly: z.boolean().readonly(),
      caught: z.number().catch(1),
      prefault: z.string().prefault("input"),
      piped: z.string().pipe(z.string().transform((value) => value.length)),
      nested: z.object({ value: z.string() }),
    }))!;
    expect(Object.fromEntries(fields.map((field) => [field.name, field.control.kind]))).toEqual({
      text: "text", choice: "select", numbers: "select", literal: "select", enabled: "switch",
      amount: "number", optional: "text", nullable: "text", defaulted: "text", readonly: "switch",
      caught: "number", prefault: "text", piped: "text", nested: "json",
    });
    expect(fields.find((field) => field.name === "numbers")!.control).toEqual({ kind: "select", options: [1, 2] });
    expect(fields.find((field) => field.name === "optional")).toMatchObject({ required: false, nullable: false });
    expect(fields.find((field) => field.name === "nullable")).toMatchObject({ required: true, nullable: true });
    expect(fields.find((field) => field.name === "defaulted")).toMatchObject({ required: false, defaultValue: "value" });
  });

  it("returns null for a non-object schema", () => {
    expect(describePropsSchema(z.string())).toBeNull();
  });

  it("describes every built-in definition and only uses JSON for structured fields", () => {
    const matrix = Object.fromEntries(["shadcn", "wireframe"].map((systemId) => {
      const definitions = getDesignSystem(systemId).definitions;
      return [systemId, Object.fromEntries(Object.entries(definitions).map(([component, definition]) => {
        const fields = describePropsSchema(definition.props);
        expect(fields, `${systemId}.${component}`).not.toBeNull();
        return [component, Object.fromEntries(fields!.map((field) => [field.name, field.control.kind]))];
      }))];
    }));
    expect(matrix).toMatchInlineSnapshot(`
      {
        "shadcn": {
          "Accordion": {
            "items": "json",
            "type": "select",
          },
          "Alert": {
            "message": "text",
            "title": "text",
            "type": "select",
          },
          "Avatar": {
            "name": "text",
            "size": "select",
            "src": "text",
          },
          "Badge": {
            "text": "text",
            "variant": "select",
          },
          "Button": {
            "disabled": "switch",
            "label": "text",
            "variant": "select",
          },
          "ButtonGroup": {
            "buttons": "json",
            "selected": "text",
          },
          "Card": {
            "centered": "switch",
            "className": "text",
            "description": "text",
            "maxWidth": "select",
            "title": "text",
          },
          "Carousel": {
            "items": "json",
          },
          "Checkbox": {
            "checked": "switch",
            "checks": "json",
            "label": "text",
            "name": "text",
            "validateOn": "select",
          },
          "Collapsible": {
            "defaultOpen": "switch",
            "title": "text",
          },
          "Dialog": {
            "description": "text",
            "openPath": "text",
            "title": "text",
          },
          "Drawer": {
            "description": "text",
            "openPath": "text",
            "title": "text",
          },
          "DropdownMenu": {
            "items": "json",
            "label": "text",
            "value": "text",
          },
          "Grid": {
            "className": "text",
            "columns": "number",
            "gap": "select",
          },
          "Heading": {
            "level": "select",
            "text": "text",
          },
          "Hotspot": {
            "ariaLabel": "text",
            "height": "number",
            "width": "number",
            "x": "number",
            "y": "number",
          },
          "Image": {
            "alt": "text",
            "height": "number",
            "src": "text",
            "width": "number",
          },
          "Input": {
            "checks": "json",
            "label": "text",
            "name": "text",
            "placeholder": "text",
            "type": "select",
            "validateOn": "select",
            "value": "text",
          },
          "Link": {
            "href": "text",
            "label": "text",
          },
          "Pagination": {
            "page": "number",
            "totalPages": "number",
          },
          "Popover": {
            "content": "text",
            "trigger": "text",
          },
          "Progress": {
            "label": "text",
            "max": "number",
            "value": "number",
          },
          "Radio": {
            "checks": "json",
            "label": "text",
            "name": "text",
            "options": "json",
            "validateOn": "select",
            "value": "text",
          },
          "Select": {
            "checks": "json",
            "label": "text",
            "name": "text",
            "options": "json",
            "placeholder": "text",
            "validateOn": "select",
            "value": "text",
          },
          "Separator": {
            "orientation": "select",
          },
          "Skeleton": {
            "height": "text",
            "rounded": "switch",
            "width": "text",
          },
          "Slider": {
            "label": "text",
            "max": "number",
            "min": "number",
            "step": "number",
            "value": "number",
          },
          "Spinner": {
            "label": "text",
            "size": "select",
          },
          "Stack": {
            "align": "select",
            "className": "text",
            "direction": "select",
            "gap": "select",
            "justify": "select",
          },
          "Switch": {
            "checked": "switch",
            "checks": "json",
            "label": "text",
            "name": "text",
            "validateOn": "select",
          },
          "Table": {
            "caption": "text",
            "columns": "json",
            "rows": "json",
          },
          "Tabs": {
            "defaultValue": "text",
            "tabs": "json",
            "value": "text",
          },
          "Text": {
            "text": "text",
            "variant": "select",
          },
          "Textarea": {
            "checks": "json",
            "label": "text",
            "name": "text",
            "placeholder": "text",
            "rows": "number",
            "validateOn": "select",
            "value": "text",
          },
          "Toggle": {
            "label": "text",
            "pressed": "switch",
            "variant": "select",
          },
          "ToggleGroup": {
            "items": "json",
            "type": "select",
            "value": "text",
          },
          "Tooltip": {
            "content": "text",
            "text": "text",
          },
        },
        "wireframe": {
          "Box": {
            "label": "text",
          },
          "Button": {
            "disabled": "switch",
            "label": "text",
          },
          "Card": {
            "title": "text",
          },
          "Checkbox": {
            "checked": "switch",
            "disabled": "switch",
            "label": "text",
          },
          "Grid": {
            "columns": "select",
          },
          "Heading": {
            "level": "select",
            "text": "text",
          },
          "Hotspot": {
            "ariaLabel": "text",
            "height": "number",
            "width": "number",
            "x": "number",
            "y": "number",
          },
          "Image": {
            "alt": "text",
            "label": "text",
          },
          "Input": {
            "disabled": "switch",
            "label": "text",
            "placeholder": "text",
            "value": "text",
          },
          "Select": {
            "disabled": "switch",
            "label": "text",
            "options": "json",
            "value": "text",
          },
          "Stack": {
            "gap": "select",
          },
          "Text": {
            "text": "text",
          },
        },
      }
    `);
  });
});
