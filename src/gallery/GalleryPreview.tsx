import { JSONUIProvider, Renderer } from "@json-render/react";
import { Component, type ErrorInfo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCjmRegistry } from "../cjm/cjmRegistry";
import { previewNativeWidth, previewTileSizes } from "../designSystems/deviceMetrics";
import { EasyUiRuntimeProvider, type EasyUiRuntimeValue } from "../player/easyUiRuntime";
import { createPlayerRuntime } from "../catalog/runtime";
import { loadPrototypeDraft } from "../prototype/loader";
import { applyComputed } from "../prototype/computed";
import { mergeScreenState } from "../prototype/stateOverrides";
import { buildScreenRenderPlan, stripEvents, toRuntimeSpec, type RuntimeTree } from "../prototype/runtimeSpec";
import type { PrototypeDraft, ThemeContent } from "../api/client";
import { useApi } from "../api/hooks";
import { HostStageSurface } from "../catalog/hostPrimitives";
import { CanvasLayers } from "../player/CanvasLayers";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { ThemeStyle, useDesignSystemTheme } from "../designSystems/theme";
import { docSurfaces, hasSurfaces } from "../prototype/surfaces";
import { ArchivedPrototype } from "../player/PrototypeLoader";
import { pillGhost } from "../app/chrome";
import { common } from "../app/strings/common";
import { gallery } from "../app/strings/gallery";

export const GALLERY_PREVIEWS_ENABLED = true;
export const GALLERY_PREVIEW_LOAD_LIMIT = 4;

type QueueEntry<T> = {
  signal: AbortSignal;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

class PreviewLoadQueue {
  private active = 0;
  private pending: QueueEntry<unknown>[] = [];

  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { signal, task, resolve, reject };
      this.pending.push(entry as QueueEntry<unknown>);
      signal.addEventListener("abort", () => {
        const index = this.pending.indexOf(entry as QueueEntry<unknown>);
        if (index !== -1) {
          this.pending.splice(index, 1);
          reject(signal.reason);
        }
      }, { once: true });
      this.drain();
    });
  }

  private drain() {
    while (this.active < GALLERY_PREVIEW_LOAD_LIMIT && this.pending.length) {
      const entry = this.pending.shift()!;
      if (entry.signal.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      this.active += 1;
      void entry.task().then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

const previewLoads = new PreviewLoadQueue();

export class GalleryPreviewErrorBoundary extends Component<{ prototypeId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(`[gallery-preview] ${this.props.prototypeId}`, error, info);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function GalleryPreviewFrame({ draft, themeContent: suppliedThemeContent, manageTheme = true }: { draft: PrototypeDraft; themeContent?: ThemeContent | null; manageTheme?: boolean }) {
  const { doc } = draft;
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const setStageHostRef = useCallback((node: HTMLDivElement | null) => setStageHost(node), []);
  const loadedThemeContent = useDesignSystemTheme(manageTheme ? doc.designSystem : undefined, manageTheme ? draft.designSystemMetaVersion : null);
  const themeContent = manageTheme ? loadedThemeContent : (suppliedThemeContent ?? null);
  const screen = doc.screens.find((candidate) => candidate.id === doc.startScreen);
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, undefined, doc.designSystem), [doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  const tree = useMemo<RuntimeTree | null>(() => {
    if (!screen) return null;
    const inert = stripEvents(toRuntimeSpec(screen.spec));
    if (!inert.spec.root || !inert.spec.elements[inert.spec.root]) return null;
    return inert;
  }, [screen]);
  const specs = useMemo(() => {
    if (!tree) return null;
    return buildScreenRenderPlan(tree, { canvas: screen?.canvas });
  }, [screen?.canvas, tree]);
  const runtimeValue = useMemo<EasyUiRuntimeValue>(() => ({ metadata: specs?.metadata ?? {}, runtime: null, definitions: {} }), [specs]);
  const initialState = useMemo(() => applyComputed(mergeScreenState(doc.state, screen?.stateOverrides), doc.computed), [doc.computed, doc.state, screen?.stateOverrides]);
  if (!screen || !tree || !specs) return null;

  const nativeWidth = screen.canvas?.width ?? previewNativeWidth[doc.device];
  const tileSize = previewTileSizes[doc.device];
  const galleryWidth = previewTileSizes.mobile.width;
  const deviceScale = tileSize.width / nativeWidth;
  const galleryScale = galleryWidth / tileSize.width;
  const scaledHeight = screen.canvas?.height === undefined
    ? tileSize.fallbackHeight * galleryScale
    : Math.min(screen.canvas.height * deviceScale, tileSize.heightCap) * galleryScale;
  const height = Math.min(scaledHeight, 200);
  const key = `${doc.id}:${draft.rev}:${screen.id}`;

  // Превью дуо-дока меряется по primary-поверхности (D3) — как и остальные непереведённые
  // читатели `doc.device`/`doc.designSystem`. Бейдж говорит, что за кадром есть вторая панель.
  const surfaces = docSurfaces(doc);
  const surfacesBadge = hasSurfaces(doc)
    ? <span
        className="pointer-events-none absolute top-1.5 left-1.5 z-10 rounded-full bg-pay-deep/85 px-2 py-0.5 text-[10px] leading-tight font-medium text-white"
        data-testid="gallery-preview-surfaces"
        title={gallery.surfacesBadgeTitle(surfaces.map((surface) => surface.name).join(", "))}
      >{gallery.surfacesBadge(surfaces.length)}</span>
    : null;

  return <>{manageTheme ? <ThemeStyle content={themeContent} /> : null}<div className="relative mx-auto max-w-full overflow-hidden rounded-inset bg-background text-foreground" style={{ width: galleryWidth, height }} data-testid={`gallery-preview-${doc.id}`}>
    {surfacesBadge}
    <div style={{ width: tileSize.width, height: height / galleryScale, transform: `scale(${galleryScale})`, transformOrigin: "top left" }}>
      <SurfaceSpacingScope systemId={doc.designSystem} themeTokens={themeContent?.tokens}>
      <div ref={setStageHostRef} inert data-eui-stage-viewport="gallery" style={{ position: "relative", width: nativeWidth, ...(screen.canvas?.height === undefined ? {} : { height: screen.canvas.height }), transform: `scale(${deviceScale})`, transformOrigin: "top left" }}>
        <JSONUIProvider key={key} registry={registry} handlers={runtime.handlers} initialState={initialState}>
          <HostStageSurface stageHostRef={stageHostRef}><div inert>
            <EasyUiRuntimeProvider value={runtimeValue}>
              {screen.canvas ? <CanvasLayers canvas={screen.canvas} specs={specs} registry={registry} /> : <>{specs.content ? <Renderer registry={registry} spec={specs.content} /> : null}{specs.overlays.map((overlaySpec) => <Renderer registry={registry} spec={overlaySpec} key={overlaySpec.root} />)}</>}
            </EasyUiRuntimeProvider>
          </div></HostStageSurface>
        </JSONUIProvider>
      </div>
      </SurfaceSpacingScope>
    </div>
  </div></>;
}

function LoadedGalleryPreview({ prototypeId }: { prototypeId: string }) {
  const draft = useApi((signal) => previewLoads.run(() => loadPrototypeDraft(prototypeId, signal), signal), [prototypeId]);
  const readyDraft = draft.status === "ready" ? draft.data : null;
  const themeContent = useDesignSystemTheme(readyDraft?.doc.designSystem, readyDraft?.designSystemMetaVersion);
  return <>
    {/* This owner exists while the draft/theme are still loading, so network resolve order cannot set priority. */}
    <ThemeStyle content={themeContent} />
    {draft.status === "error"
      ? <div className="flex h-44 flex-col items-center justify-center gap-3 rounded-inset bg-white/70 px-4 text-center" data-gallery-preview-state="error" role="status">
        <p className="text-[13px] text-eui-slate-500">{gallery.previewUnavailable}</p>
        {/* z-10: у карточки есть перекрывающая ссылка-хитбокс, иначе «Повторить» некликабельна. */}
        <button type="button" className={`${pillGhost} relative z-10`} onClick={draft.reload}>{common.retry}</button>
      </div>
      : draft.status === "loading"
      ? <div className="h-44 rounded-inset bg-white/70 pay-skeleton motion-reduce:animate-none" data-gallery-preview-state="loading" />
      : draft.data.renderable === false ? <ArchivedPrototype />
        : <GalleryPreviewFrame draft={draft.data} themeContent={themeContent} manageTheme={false} />}
  </>;
}

export function GalleryPreview({ prototypeId, wrapperClassName }: { prototypeId: string; wrapperClassName?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: "240px 0px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return <div ref={rootRef} className={`${wrapperClassName ?? "mt-5"} min-h-px`} data-gallery-preview={prototypeId} data-gallery-preview-mounted={visible ? "true" : "false"}>
    {visible ? <GalleryPreviewErrorBoundary prototypeId={prototypeId}><LoadedGalleryPreview prototypeId={prototypeId} /></GalleryPreviewErrorBoundary> : null}
  </div>;
}
