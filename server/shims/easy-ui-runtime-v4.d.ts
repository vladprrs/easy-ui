import type { ReactElement, ReactNode } from "react";
import type { BaseComponentProps } from "@json-render/react";

export interface EasyUIComponentProps<P = Record<string, unknown>> extends BaseComponentProps<P> {
  emit: (event: string, payload?: unknown) => void;
  slots: Record<string, ReactNode>;
}

export declare function token(key: string): string;
export type SpaceToken = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
export declare function space(key: SpaceToken): string;

// Open-ended color token key; fallback is mandatory so a theme rollback can never
// leave a component resolving to `undefined` (see plan H1 / D1).
export declare function color(key: string, fallback: string): string;

export interface IconProps { name: string; size?: number; theme?: "light" | "dark"; }
export declare function Icon(props: IconProps): ReactElement | null;
