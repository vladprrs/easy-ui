import type { BaseComponentProps } from "@json-render/react";
import { z } from "zod";
import { hotspotDefinition } from "./hotspot.definition";

export { hotspotDefinition } from "./hotspot.definition";

type HotspotProps = z.output<typeof hotspotDefinition.props>;

export function Hotspot({ props, emit }: BaseComponentProps<HotspotProps>) {
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      onClick={() => emit("press")}
      style={{
        position: "absolute",
        left: props.x,
        top: props.y,
        width: props.width,
        height: props.height,
        border: 0,
        padding: 0,
        background: "transparent",
      }}
    />
  );
}
