import { useBoundProp, type BaseComponentProps } from "@json-render/react";
import type { z } from "zod";
import { Hotspot } from "../../catalog/hotspot";
import type { wireframeSourceDefinitions } from "./definitions";

type Props<Name extends keyof typeof wireframeSourceDefinitions> = z.output<
  (typeof wireframeSourceDefinitions)[Name]["props"]
>;

export function Box({ props, children }: BaseComponentProps<Props<"Box">>) {
  return <div className="border border-dashed border-gray-400 bg-gray-50 p-4" aria-label={props.label}>{children}</div>;
}

export function Stack({ props, children }: BaseComponentProps<Props<"Stack">>) {
  const gap = { none: "gap-0", xs: "gap-1", sm: "gap-2", md: "gap-4", lg: "gap-6", xl: "gap-8", "2xl": "gap-12", "3xl": "gap-16", "4xl": "gap-20" }[props.gap];
  return <div className={`flex flex-col ${gap}`}>{children}</div>;
}

export function Grid({ props, children }: BaseComponentProps<Props<"Grid">>) {
  const columns = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" }[props.columns];
  return <div className={`grid gap-4 ${columns}`}>{children}</div>;
}

export function Heading({ props }: BaseComponentProps<Props<"Heading">>) {
  const Tag = ({ 1: "h1", 2: "h2", 3: "h3", 4: "h4" } as const)[props.level];
  return <Tag className="font-mono text-xl font-bold text-gray-800">{props.text}</Tag>;
}

export function Text({ props }: BaseComponentProps<Props<"Text">>) {
  return <p className="font-mono text-sm text-gray-600">{props.text}</p>;
}

export function Image({ props }: BaseComponentProps<Props<"Image">>) {
  return (
    <div
      role="img"
      aria-label={props.alt}
      className="relative flex min-h-32 items-center justify-center overflow-hidden border border-dashed border-gray-500 bg-gray-200 font-mono text-xs text-gray-600"
    >
      <span className="absolute h-px w-[140%] rotate-[25deg] bg-gray-400" />
      <span className="absolute h-px w-[140%] -rotate-[25deg] bg-gray-400" />
      <span className="relative bg-gray-200 px-2">{props.label}</span>
    </div>
  );
}

export function Button({ props, on }: BaseComponentProps<Props<"Button">>) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="border border-dashed border-gray-600 bg-gray-100 px-4 py-2 font-mono text-sm text-gray-800 disabled:opacity-50"
      onClick={(event) => {
        const press = on("press");
        if (press.shouldPreventDefault) event.preventDefault();
        press.emit();
      }}
    >
      {props.label}
    </button>
  );
}

export function Input({ props, bindings, emit }: BaseComponentProps<Props<"Input">>) {
  const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
  return (
    <label className="flex flex-col gap-1 font-mono text-xs text-gray-600">
      {props.label}
      <input
        type="text"
        value={value ?? ""}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => { setValue(event.target.value); emit("change"); }}
        className="border border-dashed border-gray-500 bg-white px-3 py-2 text-sm text-gray-800 outline-none"
      />
    </label>
  );
}

export function Checkbox({ props, bindings, emit }: BaseComponentProps<Props<"Checkbox">>) {
  const [checked, setChecked] = useBoundProp<boolean>(props.checked, bindings?.checked);
  return (
    <label className="inline-flex items-center gap-2 font-mono text-sm text-gray-700">
      <input type="checkbox" checked={checked ?? false} disabled={props.disabled} onChange={(event) => { setChecked(event.target.checked); emit("change"); }} />
      {props.label}
    </label>
  );
}

export function Select({ props, bindings, emit }: BaseComponentProps<Props<"Select">>) {
  const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
  return (
    <label className="flex flex-col gap-1 font-mono text-xs text-gray-600">
      {props.label}
      <select
        value={value ?? ""}
        disabled={props.disabled}
        onChange={(event) => { setValue(event.target.value); emit("change"); }}
        className="border border-dashed border-gray-500 bg-white px-3 py-2 text-sm text-gray-800"
      >
        {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

export function Card({ props, children }: BaseComponentProps<Props<"Card">>) {
  return (
    <section className="border-2 border-dashed border-gray-500 bg-gray-50 p-4">
      {props.title ? <h3 className="mb-3 border-b border-dashed border-gray-400 pb-2 font-mono font-bold text-gray-800">{props.title}</h3> : null}
      {children}
    </section>
  );
}

export const wireframeComponents = {
  Box,
  Stack,
  Grid,
  Heading,
  Text,
  Image,
  Button,
  Input,
  Checkbox,
  Hotspot,
  Select,
  Card,
};
