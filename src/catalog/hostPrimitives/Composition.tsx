import type { BaseComponentProps } from "@json-render/react";

/**
 * Оборонительный passthrough: `@eui/Composition` и `@eui/Slot` раскрываются
 * (`expandCompositions`) до построения runtime-дерева, поэтому в рантайме
 * встречаться не должны. Если элемент всё же дошёл до рендера — показываем детей,
 * а не пустоту, и помечаем узел атрибутом для диагностики.
 */
export function CompositionPlaceholder({ children }: BaseComponentProps<Record<string, never>>) {
  return <div data-eui-host-primitive="Composition">{children}</div>;
}

export function SlotPlaceholder({ children }: BaseComponentProps<Record<string, never>>) {
  return <div data-eui-host-primitive="Slot">{children}</div>;
}
