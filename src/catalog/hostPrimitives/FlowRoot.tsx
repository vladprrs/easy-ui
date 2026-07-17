import type { BaseComponentProps } from "@json-render/react";

/** A block container that deliberately contributes no layout or inherited styles. */
export function FlowRoot({ children }: BaseComponentProps<Record<string, never>>) {
  return <div data-eui-host-primitive="FlowRoot">{children}</div>;
}

