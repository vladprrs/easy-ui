import type { BaseComponentProps } from "@json-render/react";
import type { ImageProps } from "./image.definition";

export function Image({ props }: BaseComponentProps<ImageProps>) {
  return (
    <img
      src={props.src}
      alt={props.alt}
      width={props.width}
      height={props.height}
      style={{ display: "block", maxWidth: "100%", objectFit: props.objectFit }}
    />
  );
}
