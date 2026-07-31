import { useInsertionEffect, type CSSProperties, type ReactNode } from "react";
import type { ThemeContent } from "../api/client";
import { SurfaceSpacingScope } from "./SurfaceSpacingScope";
import { tokenCssVar } from "./theme";

// Per-card тема для инлайн-превью: токены дизайн-системы кладутся инлайн-переменными на обёртку и
// наследуются только в её поддерево, перекрывая :root документного владельца темы. color()/space()
// опубликованных бандлов — это чистые var(--eui-*), поэтому две системы на одной странице не
// пересекаются. (token()/Icon читают единственный глобальный снапшот и остаются за владельцем.)

type ScopedStyle = CSSProperties & Record<`--eui-${string}`, string>;

/**
 * Токены темы как инлайн custom properties. Значения — сырые: React ставит `--*` через
 * setProperty, и cssEscapeString (нужный только для текста CSS) дал бы литеральные `\22 `.
 * `space.*` пропускаются — их namespace принадлежит SurfaceSpacingScope (как в serializeThemeCss).
 */
export function scopedThemeStyle(tokens: ThemeContent["tokens"] | undefined): ScopedStyle {
  const entries = Object.entries(tokens ?? {})
    .filter(([key]) => !key.startsWith("space."))
    .map(([key, value]) => [tokenCssVar(key), String(value)]);
  return Object.fromEntries(entries) as ScopedStyle;
}

const SCOPE_ATTR = "data-eui-scoped-surface";

// Эквивалент CaptureChrome/CaptureStyle, но scoped: useCaptureTheme не переиспользуем — он
// переключает классы на document.documentElement, а превью не имеет права трогать хром.
const RESET_CSS =
  `[${SCOPE_ATTR}],[${SCOPE_ATTR}] *,[${SCOPE_ATTR}] *::before,[${SCOPE_ATTR}] *::after` +
  "{animation-duration:0s!important;animation-delay:0s!important;" +
  "transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}";

let resetCount = 0;
let resetStyle: HTMLStyleElement | null = null;

function acquireScopedReset(): () => void {
  resetCount += 1;
  if (!resetStyle || !resetStyle.isConnected) {
    resetStyle = document.createElement("style");
    resetStyle.dataset.euiScopedReset = "";
    resetStyle.textContent = RESET_CSS;
    document.head.append(resetStyle);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    resetCount -= 1;
    if (resetCount > 0) return;
    resetStyle?.remove();
    resetStyle = null;
  };
}

/**
 * Обёртка превью: токены системы + spacing-scope на ОДНОМ элементе (SurfaceSpacingScope
 * cloneElement-ит единственного ребёнка и дописывает свой style поверх нашего).
 */
export function ScopedThemeSurface({ systemId, theme, className, resetAnimations = true, children }: {
  systemId: string;
  theme: ThemeContent | null | undefined;
  className?: string;
  resetAnimations?: boolean;
  children: ReactNode;
}) {
  useInsertionEffect(() => {
    if (!resetAnimations) return;
    return acquireScopedReset();
  }, [resetAnimations]);

  return <SurfaceSpacingScope systemId={systemId} themeTokens={theme?.tokens}>
    <div className={className} style={scopedThemeStyle(theme?.tokens)} data-eui-scoped-surface="" data-eui-scoped-system={systemId}>
      {children}
    </div>
  </SurfaceSpacingScope>;
}
