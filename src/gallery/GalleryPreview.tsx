import { JSONUIProvider, Renderer } from "@json-render/react";
import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createCjmRegistry } from "../cjm/cjmRegistry";
import { previewNativeWidth, previewTileSizes } from "../designSystems/deviceMetrics";
import { EasyUiRuntimeProvider, type EasyUiRuntimeValue } from "../player/easyUiRuntime";
import { createPlayerRuntime } from "../catalog/runtime";
import { loadPrototypeDraft } from "../prototype/loader";
import { mergeScreenState } from "../prototype/stateOverrides";
import { splitCanvas, stripEvents, toRuntimeSpec, type RuntimeTree } from "../prototype/runtimeSpec";
import type { PrototypeDraft } from "../api/client";
import { useApi } from "../api/hooks";

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

function GalleryPreviewFrame({ draft }: { draft: PrototypeDraft }) {
  const { doc } = draft;
  const screen = doc.screens.find((candidate) => candidate.id === doc.startScreen);
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, undefined, doc.designSystem), [doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  const tree = useMemo<RuntimeTree | null>(() => {
    if (!screen) return null;
    const inert = stripEvents(toRuntimeSpec(screen.spec));
    if (!inert.spec.root || !inert.spec.elements[inert.spec.root]) return null;
    return screen.canvas ? splitCanvas(inert).content : inert;
  }, [screen]);
  const runtimeValue = useMemo<EasyUiRuntimeValue>(() => ({ metadata: tree?.metadata ?? {}, runtime: null, definitions: {} }), [tree]);
  const initialState = useMemo(() => mergeScreenState(doc.state, screen?.stateOverrides), [doc.state, screen?.stateOverrides]);
  if (!screen || !tree) return null;

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

  return <div className="mx-auto max-w-full overflow-hidden rounded-2xl bg-background text-foreground shadow-sm" style={{ width: galleryWidth, height }} data-testid={`gallery-preview-${doc.id}`}>
    <div style={{ width: tileSize.width, height: height / galleryScale, transform: `scale(${galleryScale})`, transformOrigin: "top left" }}>
      <div style={{ width: nativeWidth, ...(screen.canvas?.height === undefined ? {} : { height: screen.canvas.height }), transform: `scale(${deviceScale})`, transformOrigin: "top left" }}>
        <JSONUIProvider key={key} registry={registry} handlers={runtime.handlers} initialState={initialState}>
          <div inert>
            <EasyUiRuntimeProvider value={runtimeValue}>
              <Renderer registry={registry} spec={tree.spec} />
            </EasyUiRuntimeProvider>
          </div>
        </JSONUIProvider>
      </div>
    </div>
  </div>;
}

function LoadedGalleryPreview({ prototypeId }: { prototypeId: string }) {
  const draft = useApi((signal) => previewLoads.run(() => loadPrototypeDraft(prototypeId, signal), signal), [prototypeId]);
  if (draft.status === "error") return <div data-gallery-preview-state="error" />;
  if (draft.status === "loading") return <div className="h-44 animate-pulse rounded-2xl bg-white/60 motion-reduce:animate-none" data-gallery-preview-state="loading" />;
  return <GalleryPreviewFrame draft={draft.data} />;
}

export function GalleryPreview({ prototypeId }: { prototypeId: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: "240px 0px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return <div ref={rootRef} className="mt-5 min-h-px" data-gallery-preview={prototypeId} data-gallery-preview-mounted={visible ? "true" : "false"}>
    {visible ? <GalleryPreviewErrorBoundary prototypeId={prototypeId}><LoadedGalleryPreview prototypeId={prototypeId} /></GalleryPreviewErrorBoundary> : null}
  </div>;
}
