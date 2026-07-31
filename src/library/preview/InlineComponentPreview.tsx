import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactElement } from "react";
import { getComponentPreview, type ComponentPreviewData, type LibraryCatalogEntry, type ThemeContent } from "../../api/client";
import { pillGhost } from "../../app/chrome";
import { library } from "../../app/strings/library";
import type { CustomPlayerRuntime } from "../../catalog/runtime";
import { FullDocumentReloadRequiredError, loadCustomComponents } from "../../customComponents/loader";
import { acquireThemeFonts } from "../../designSystems/fontRegistry";
import { ScopedThemeSurface } from "../../designSystems/ScopedThemeSurface";
import { themeCache } from "../../designSystems/themeCache";
import { PreviewErrorBoundary } from "../componentPage/PreviewErrorBoundary";
import { libraryEntryKey } from "../libraryTiers";
import { FitToBox } from "./FitToBox";
import { acquireMountedPreview, viewportDistance } from "./mountedRegistry";
import { previewScheduler, type PreviewPriority } from "./previewScheduler";
import { RuntimePreview, usePreviewRuntime } from "./renderPreview";

// Инлайн-превью карточки библиотеки (план 2026-07-31 §4.4) — замена iframe `/capture/component/...`.
// Один same-origin iframe на карточку бутал полный SPA; здесь компонент рендерится в дереве страницы
// с per-card темой, а его жизненный цикл ограничен вьюпортом и бюджетом смонтированных превью.

/** Ближняя полоса — постановка в очередь; дальняя — размонтирование (спека §5). */
const NEAR_MARGIN = "240px 0px";
const FAR_MARGIN = "800px 0px";

export type InlinePreviewState = "idle" | "queued" | "loading" | "ready" | "error" | "missing";
/** Различается только в `data-*`-диагностике: в UI у всех четырёх одна компактная плашка. */
type PreviewErrorKind = "metadata" | "theme" | "bundle" | "render";

interface LoadedPreview {
  data: ComponentPreviewData;
  theme: ThemeContent;
  metaVersion: number | null;
  loaded: CustomPlayerRuntime;
}

class PreviewStageError extends Error {
  constructor(readonly kind: Exclude<PreviewErrorKind, "render">, readonly reason: unknown) {
    super(`preview ${kind} stage failed`, { cause: reason });
    this.name = "PreviewStageError";
  }
}

const isAbort = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError");

async function stage<T>(kind: Exclude<PreviewErrorKind, "render">, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new PreviewStageError(kind, error);
  }
}

export interface InlineComponentPreviewProps {
  entry: LibraryCatalogEntry;
  /** Приоритет задачи планировщика; меняется без перезапуска загрузки (`reprioritize`). */
  priority: PreviewPriority;
  className?: string;
}

export function InlineComponentPreview({ entry, priority, className }: InlineComponentPreviewProps): ReactElement {
  const key = libraryEntryKey(entry);
  const selector = entry.preview;
  const rootRef = useRef<HTMLDivElement>(null);
  // В jsdom IntersectionObserver-а нет — монтируемся сразу, как это делал прежний ComponentPreview.
  const [active, setActive] = useState(() => selector !== null && typeof IntersectionObserver === "undefined");
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<"queued" | "loading">("queued");
  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [failure, setFailure] = useState<{ kind: PreviewErrorKind; reloadRequired: boolean } | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  const schedulerKey = `${key}@${entry.version}#${generation}`;
  const currentPriority = useEffectEvent(() => priority);

  /** Уход из дальней полосы и вытеснение реестром — один и тот же сброс до пустого превью. */
  const deactivate = useCallback(() => {
    setActive(false);
    setPreview(null);
    setFailure(null);
    setRenderFailed(false);
    setPhase("queued");
  }, []);

  useEffect(() => {
    const node = rootRef.current;
    if (selector === null || !node || typeof IntersectionObserver === "undefined") return;
    // Наблюдатель не защёлкивающий: вход в ближнюю полосу ставит в очередь, выход из дальней снимает.
    const near = new IntersectionObserver((entries) => {
      if (entries.some((observed) => observed.isIntersecting)) setActive(true);
    }, { rootMargin: NEAR_MARGIN });
    const far = new IntersectionObserver((entries) => {
      if (entries.every((observed) => !observed.isIntersecting)) deactivate();
    }, { rootMargin: FAR_MARGIN });
    near.observe(node);
    far.observe(node);
    return () => { near.disconnect(); far.disconnect(); };
  }, [deactivate, selector]);

  useEffect(() => {
    if (!active || selector === null) return;
    const controller = new AbortController();
    let disposed = false;
    previewScheduler.run(schedulerKey, currentPriority(), async (signal) => {
      if (!disposed) setPhase("loading");
      const data = await stage("metadata", () => getComponentPreview(entry.id, entry.version, selector, signal));
      const theme = await stage("theme", () => themeCache.get(data.designSystem));
      const loaded = await stage("bundle", () => loadCustomComponents([{
        id: data.componentId, name: data.name, version: data.version, bundleUrl: data.bundleUrl, bundleHash: data.bundleHash,
      }]));
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      return { data, theme: theme.content, metaVersion: theme.latestMetaVersion, loaded } satisfies LoadedPreview;
    }, controller.signal).then((value) => {
      if (!disposed) setPreview(value);
    }, (error: unknown) => {
      if (disposed || isAbort(error)) return;
      const reason = error instanceof PreviewStageError ? error.reason : error;
      setFailure({
        kind: error instanceof PreviewStageError ? error.kind : "metadata",
        reloadRequired: reason instanceof FullDocumentReloadRequiredError,
      });
    });
    return () => {
      disposed = true;
      controller.abort(new DOMException("preview unmounted", "AbortError"));
    };
  }, [active, entry.id, entry.version, schedulerKey, selector]);

  useEffect(() => { previewScheduler.reprioritize(schedulerKey, priority); }, [schedulerKey, priority]);

  useEffect(() => {
    if (!active) return;
    return acquireMountedPreview(key, {
      distance: () => viewportDistance(rootRef.current),
      unmount: deactivate,
    });
  }, [active, deactivate, key]);

  useEffect(() => {
    if (!preview) return;
    return acquireThemeFonts(preview.data.designSystem, preview.metaVersion, preview.theme);
  }, [preview]);

  const errorKind: PreviewErrorKind | null = failure ? failure.kind : renderFailed ? "render" : null;
  const state: InlinePreviewState = selector === null ? "missing"
    : errorKind !== null ? "error"
    : preview ? "ready"
    : active ? phase
    : "idle";

  const retry = () => {
    setFailure(null);
    setRenderFailed(false);
    setPreview(null);
    setGeneration((value) => value + 1);
  };
  const plate = failure?.reloadRequired
    ? <PreviewPlate message={library.previewReloadRequired} actionLabel={library.previewReload} onAction={() => window.location.reload()} />
    : <PreviewPlate message={library.previewFailed} actionLabel={library.retry} onAction={retry} />;

  return <div
    ref={rootRef}
    className={`absolute inset-0 ${className ?? ""}`}
    data-component-preview={key}
    data-component-preview-mounted={preview ? "true" : "false"}
    data-component-preview-state={state}
    data-component-preview-error={errorKind ?? undefined}
  >
    {selector === null ? <div className="flex h-full w-full items-center justify-center"><ComponentPreviewMissing /></div>
      : failure ? plate
      : preview ? <ScopedThemeSurface systemId={preview.data.designSystem} theme={preview.theme} className="h-full w-full">
        <PreviewErrorBoundary
          resetGeneration={generation}
          reportedError={renderFailed}
          onErrorStateChange={setRenderFailed}
          fallback={<PreviewPlate message={library.previewFailed} actionLabel={library.retry} onAction={retry} />}
        >
          <FitToBox>
            <PreviewTree preview={preview} onError={() => setRenderFailed(true)} />
          </FitToBox>
        </PreviewErrorBoundary>
      </ScopedThemeSurface>
      : null}
  </div>;
}

/**
 * Карточка витрины показывает компонент таким, каким он выйдет в прототипе, поэтому
 * плейсхолдеры слотов не подставляются: `slots: []` вместо `preview.data`. Так же вёл себя
 * прежний iframe — `/capture/component/...` рендерит только example-props (см. CaptureComponent),
 * а плейсхолдеры — приём страницы компонента, где слоты изучают. Внутри карточки они
 * накладывались бы на собственное содержимое компонента.
 */
const NO_SLOT_PLACEHOLDERS = { slots: [] as readonly string[] };

/** Отдельный компонент: `usePreviewRuntime` — хук, а рантайм существует только после загрузки. */
function PreviewTree({ preview, onError }: { preview: LoadedPreview; onError: () => void }): ReactElement {
  const runtime = usePreviewRuntime(preview.loaded, onError);
  return <RuntimePreview
    componentName={preview.data.name}
    designSystem={preview.data.designSystem}
    source={NO_SLOT_PLACEHOLDERS}
    props={preview.data.props}
    runtime={runtime}
    onError={onError}
  />;
}

/**
 * Одна компактная плашка на все виды сбоя. Кнопка поднята над stretched-link карточки (`z-10`),
 * иначе ссылка на страницу компонента перехватила бы клик по «Повторить».
 */
function PreviewPlate({ message, actionLabel, onAction }: { message: string; actionLabel: string; onAction: () => void }): ReactElement {
  return <div role="alert" className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
    <p className="text-[13px] text-eui-slate-500">{message}</p>
    <button type="button" className={`${pillGhost} relative z-10`} onClick={onAction}>{actionLabel}</button>
  </div>;
}

/** Компонент без example-props: вместо превью — честная плашка, а не пустая зона. */
export function ComponentPreviewMissing(): ReactElement {
  return <p className="px-5 text-center text-[13px] text-eui-slate-500">{library.previewMissing}</p>;
}
