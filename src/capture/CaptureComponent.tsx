import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api/hooks";
import { getComponentMeta, getComponentVersion, getDesignSystemById, type ComponentVersion, type ThemeContent } from "../api/client";
import { loadCustomComponents } from "../customComponents/loader";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { ThemeStyle } from "../designSystems/theme";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { HostStageSurface } from "../catalog/hostPrimitives";
import { CaptureSurface } from "./CaptureSurface";
import { CaptureStyle, useCaptureTheme, usePublishError } from "./CaptureChrome";
import { bootstrapRendererBuild, publishReady, readBootstrap, settleSurface } from "./readiness";
import { propsHashBrowser } from "./propsHash";
import type { CaptureReady, CaptureSlotsBootstrap, ComponentDraftExpected } from "./protocol";

interface LoadedComponent {
  id: string;
  name: string;
  version: ComponentVersion;
  props: Record<string, unknown>;
  dsMetaVersion: number | null;
  theme: ThemeContent | null;
}

type PropsSelection =
  | { kind: "empty" }
  | { kind: "legacy" }
  | { kind: "named"; name: string }
  | { kind: "error"; message: string };

function propsSelection(search: URLSearchParams): PropsSelection {
  const examples = search.getAll("example");
  const props = search.getAll("props");
  if (examples.length > 1 || props.length > 1) return { kind: "error", message: "Duplicate props selector" };
  if (props.length === 1 && props[0] !== "example") return { kind: "error", message: "Invalid props selector" };
  if (examples.length === 1) return { kind: "named", name: examples[0] };
  if (props.length === 1) return { kind: "legacy" };
  return { kind: "empty" };
}

function selectedProps(versionDto: ComponentVersion, selection: PropsSelection): Record<string, unknown> {
  const bootstrap = readBootstrap();
  if (bootstrap?.kind === "component" && bootstrap.props) return bootstrap.props;
  if (selection.kind === "error") throw new Error(selection.message);
  if (selection.kind === "legacy") {
    if (!versionDto.example) throw new Error("Example props are not available");
    return versionDto.example;
  }
  if (selection.kind === "named") {
    const examples = versionDto.examples ?? Object.create(null) as Record<string, Record<string, unknown>>;
    if (!Object.hasOwn(examples, selection.name)) throw new Error(`Unknown example: ${selection.name}`);
    return examples[selection.name];
  }
  return {};
}

async function loadComponent(id: string, version: number, selection: PropsSelection, signal: AbortSignal): Promise<LoadedComponent> {
  const [meta, versionDto] = await Promise.all([getComponentMeta(id, signal), getComponentVersion(id, version, signal)]);
  const props = selectedProps(versionDto, selection);
  // Components are not theme-pinned: use the latest theme of the component's design system.
  let dsMetaVersion: number | null = null; let theme: ThemeContent | null = null;
  try { const ds = await getDesignSystemById(versionDto.designSystem, signal); dsMetaVersion = ds.latestMetaVersion ?? null; theme = { tokens: ds.tokens ?? {}, fonts: ds.fonts ?? [], icons: ds.icons ?? [] }; } catch { /* theme is best-effort */ }
  return { id, name: meta.name, version: versionDto, props, dsMetaVersion, theme };
}

/**
 * Поле paint-режима (план 2026-08-03 §3 D4, W3). `null` — обычный режим: поверхность остаётся
 * непрозрачной и без поля, то есть существующие захваты не меняются ни на пиксель.
 */
function paintFieldPadding(): { top: number; right: number; bottom: number; left: number } | null {
  const paint = readBootstrap()?.paint;
  if (!paint) return null;
  const side = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  // BR-02: per-side форма сильнее скалярной, но не смешивается с ней — union протокола (см.
  // `CapturePaintField`), поэтому «одна сторона поверх скаляра» здесь невыразимо by construction.
  if ("paddingPx" in paint) {
    const padding = (paint as { paddingPx?: Record<string, unknown> }).paddingPx;
    if (!padding) return null;
    const top = side(padding.top), right = side(padding.right), bottom = side(padding.bottom), left = side(padding.left);
    return top === null || right === null || bottom === null || left === null ? null : { top, right, bottom, left };
  }
  const margin = side((paint as { marginPx?: unknown }).marginPx);
  return margin === null ? null : { top: margin, right: margin, bottom: margin, left: margin };
}

/**
 * Поверхность съёмки (план 2026-08-06 §W5 T5c.1). `null` — hug: поверхность обжимает компонент,
 * и путь остаётся доволновым **до последнего узла**. `"viewport"` — внутрь внешнего padded
 * `#eui-capture-surface` добавляется узел точного размера вьюпорта, и он же становится stage host'ом
 * `HostStageSurface`: без провайдера host-примитив `Overlay` в компонентном капчуре возвращал
 * `null`, то есть модалку было нечем снять вовсе.
 */
function captureViewportSurface(): { width: number; height: number } | null {
  const surface = readBootstrap()?.surface;
  if (!surface || surface.mode !== "viewport") return null;
  const { width, height } = surface;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Сцена компонента: на hug-поверхности — ровно то же дерево, что и до волны (никакого лишнего узла
 * и никакого провайдера), на viewport-поверхности — узел точного размера вьюпорта со stage host'ом.
 */
function CaptureStage({ viewport, children }: { viewport: { width: number; height: number } | null; children: ReactNode }) {
  // Тот же приём, что в `CapturePrototype`: узел-хост приезжает состоянием, а не ref'ом, иначе
  // первый рендер отдал бы `Overlay` пустой `current` и портал не смонтировался бы никогда.
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  if (!viewport) return <>{children}</>;
  return <div
    ref={setStageHost}
    data-eui-capture-viewport=""
    style={{ position: "relative", width: `${viewport.width}px`, height: `${viewport.height}px` }}
  >
    <HostStageSurface stageHostRef={stageHostRef}>{children}</HostStageSurface>
  </div>;
}

/**
 * Дерево кандидатного капчура (план 2026-08-05 §A6, вложенность — 2026-08-06 §W6). Без `slots` —
 * то же одноэлементное дерево, что и до волны (бесслотовый кадр обязан остаться байт-в-байт
 * прежним). Со слотами — родитель `c` с детьми `s0…sN` в порядке рендера: **именованный** ребёнок
 * несёт `slot`, ребёнок неявного дефолтного слота — не несёт ключа вовсе (§A2a; `runtimeSpec`
 * схлопывает обе формы в `slotIndices.default`). `customTypes` — родитель плюс имена всех детей.
 *
 * `tree` приезжает **плоским**: вложенность выражена ссылками `entry.children` на индексы того же
 * массива, а детьми корня становятся записи, на которые никто не ссылается. Рантайм произвольную
 * глубину слотов умеет сам (`runtimeSpec.ts` — `slotIndices` строится для каждого custom-элемента).
 */
function captureRuntimeTree(name: string, props: Record<string, unknown>, slots: CaptureSlotsBootstrap | undefined) {
  const entries = slots?.tree ?? [];
  if (entries.length === 0) {
    return toRuntimeSpec(
      { root: "c", elements: { c: { type: name, props } } } as Parameters<typeof toRuntimeSpec>[0],
      { customTypes: new Set([name]) },
    );
  }
  const keys = entries.map((_, index) => `s${index}`);
  const nested = new Set<number>();
  for (const entry of entries) for (const index of entry.children ?? []) nested.add(index);
  const rootKeys = keys.filter((_, index) => !nested.has(index));
  const elements: Record<string, unknown> = { c: { type: name, props, children: rootKeys } };
  entries.forEach((entry, index) => {
    const children = (entry.children ?? []).map((child) => keys[child]).filter((key): key is string => key !== undefined);
    elements[keys[index]] = {
      type: entry.name, props: entry.props ?? {},
      ...(entry.slot ? { slot: entry.slot } : {}),
      ...(children.length === 0 ? {} : { children }),
    };
  });
  return toRuntimeSpec(
    { root: "c", elements } as Parameters<typeof toRuntimeSpec>[0],
    { customTypes: new Set([name, ...entries.map((entry) => entry.name)]) },
  );
}

/**
 * Shared single-component capture surface: renders the resolved tree, then publishes the
 * readiness object built by `readyOf` (published version or draft rev — P1b).
 */
function ComponentCaptureSurface({ name, designSystem, theme, props, custom, slots, readyOf }: {
  name: string; designSystem: string; theme: ThemeContent | null;
  props: Record<string, unknown>; custom: CustomPlayerRuntime;
  slots?: CaptureSlotsBootstrap;
  readyOf: (propsHash: string) => CaptureReady;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const tree = useMemo(() => captureRuntimeTree(name, props, slots), [name, props, slots]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const propsHash = await propsHashBrowser(props);
        // W4: доказательство готовности и отпечаток окружения едут рядом с handshake-полями;
        // `readyToExpected` их не видит, поэтому сравнение с `expected` не меняется.
        const { readiness, env } = await settleSurface(ref.current ?? document);
        if (!cancelled) publishReady({ ...readyOf(propsHash), readiness, env });
      } catch (error) {
        if (!cancelled) publishReady({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paint-режим: прозрачный фон (иначе `omitBackground` бессмыслен — краску закрывает
  // `bg-background`) плюс поле вокруг компонента, чтобы тень/блюр попали в кадр целиком.
  const paintPadding = paintFieldPadding();
  const viewportSurface = captureViewportSurface();
  return <SurfaceSpacingScope systemId={designSystem} themeTokens={theme?.tokens}>
    <div
      ref={ref}
      id="eui-capture-surface"
      className={paintPadding === null ? "bg-background text-foreground inline-block" : "text-foreground inline-block"}
      {...(paintPadding === null
        ? {}
        // BR-02: четырёхстороннее CSS-padding. Скалярная форма протокола раскрывается в четыре
        // равные стороны выше, поэтому доволновая джоба даёт ровно прежнюю строку `64px 64px 64px 64px`
        // — те же пиксели, что `padding: 64px`.
        : { style: {
          padding: `${paintPadding.top}px ${paintPadding.right}px ${paintPadding.bottom}px ${paintPadding.left}px`,
          background: "transparent",
        } })}
    >
      {/* Прозрачный документ: без этого `omitBackground` бессмыслен — краску закрыл бы фон body. */}
      {paintPadding === null ? null : <style>{"html,body{background:transparent!important}"}</style>}
      <ThemeStyle content={theme} />
      <CaptureStage viewport={viewportSurface}>
        <CaptureSurface designSystem={designSystem} custom={custom} tree={tree} initialState={{}} screenIds={new Set()} />
      </CaptureStage>
    </div>
  </SurfaceSpacingScope>;
}

function LoadedComponentCapture({ loaded, custom }: { loaded: LoadedComponent; custom: CustomPlayerRuntime }) {
  const { version } = loaded;
  return <ComponentCaptureSurface name={loaded.name} designSystem={version.designSystem} theme={loaded.theme} props={loaded.props} custom={custom}
    readyOf={(propsHash) => ({
      status: "ready", kind: "component", componentId: loaded.id, version: version.version,
      bundleHash: version.bundleHash, propsHash, dsMetaVersion: loaded.dsMetaVersion, rendererBuild: bootstrapRendererBuild(),
    })} />;
}

function WithComponent({ loaded }: { loaded: LoadedComponent }) {
  const custom = useApi((signal) => loadComponentRuntime(loaded, signal), [loaded.id, loaded.version.version]);
  usePublishError(custom.status === "error" ? errorMessage(custom.error) : null);
  if (custom.status === "loading") return <div id="eui-capture-loading" />;
  if (custom.status === "error") return <div data-capture-error="components" />;
  return <LoadedComponentCapture loaded={loaded} custom={custom.data} />;
}

async function loadComponentRuntime(loaded: LoadedComponent, signal: AbortSignal): Promise<CustomPlayerRuntime> {
  const result = await loadCustomComponents([{
    id: loaded.id, name: loaded.name, version: loaded.version.version,
    bundleUrl: `/api/components/${encodeURIComponent(loaded.id)}/versions/${loaded.version.version}/bundle.js`,
    bundleHash: loaded.version.bundleHash,
  }]);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return result;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CaptureComponent() {
  const { id, version } = useParams();
  const [search] = useSearchParams();
  const theme = search.get("theme") === "dark" ? "dark" : "light";
  useCaptureTheme(theme);
  const versionNumber = version !== undefined && /^[1-9][0-9]*$/.test(version) ? Number(version) : undefined;
  const selection = useMemo(() => propsSelection(search), [search]);

  const state = useApi((signal) => loadComponent(id ?? "", versionNumber ?? 0, selection, signal), [id, versionNumber, selection]);
  usePublishError(state.status === "error" ? errorMessage(state.error) : versionNumber === undefined ? "Invalid version" : null);

  return <>
    <CaptureStyle />
    {versionNumber === undefined ? <div data-capture-error="version" />
      : state.status === "loading" ? <div id="eui-capture-loading" />
      : state.status === "error" ? <div data-capture-error="load" />
      : <WithComponent loaded={state.data} />}
  </>;
}

// --- Draft head-revision capture (план 2026-08-02, P1b) ------------------------------
// Рендер сохранённой, но не опубликованной head-ревизии из эфемерного candidate-bundle.
// Published-DTO у драфта нет: цель (name/designSystem/bundleUrl) приезжает в bootstrap.target,
// props-схема/examples — в расширенном bootstrap; оба job-scoped по построению.

interface LoadedDraftComponent {
  id: string;
  name: string;
  rev: number;
  sourceHash: string;
  bundleHash: string;
  bundleUrl: string;
  designSystem: string;
  props: Record<string, unknown>;
  dsMetaVersion: number | null;
  theme: ThemeContent | null;
  /** Слот-содержимое случая приёмки (§A6); отсутствует у бесслотового кадра. */
  slots?: CaptureSlotsBootstrap;
  /** Эхо `expected.slotsHash` — поверхность его не пересчитывает (§A6, домашний паттерн). */
  slotsHash?: string;
}

/** Reads and validates the worker bootstrap; a draft capture has no browser fallback. */
function readDraftBootstrap(): { expected: ComponentDraftExpected; name: string; designSystem: string; bundleUrl: string; props: Record<string, unknown>; slots?: CaptureSlotsBootstrap } {
  const bootstrap = readBootstrap();
  if (bootstrap?.kind !== "component-draft" || bootstrap.expected.kind !== "component-draft") {
    throw new Error("Draft component capture requires a component-draft capture bootstrap");
  }
  const target = bootstrap.target as { componentId?: unknown; rev?: unknown; name?: unknown; designSystem?: unknown; bundleUrl?: unknown };
  if (target.componentId !== bootstrap.expected.componentId || target.rev !== bootstrap.expected.rev
    || typeof target.name !== "string" || typeof target.designSystem !== "string" || typeof target.bundleUrl !== "string") {
    throw new Error("Draft component capture bootstrap target is invalid");
  }
  return {
    expected: bootstrap.expected,
    name: target.name, designSystem: target.designSystem, bundleUrl: target.bundleUrl,
    props: bootstrap.props ?? {},
    ...(bootstrap.slots === undefined ? {} : { slots: bootstrap.slots }),
  };
}

async function loadDraftComponent(id: string, signal: AbortSignal): Promise<LoadedDraftComponent> {
  const { expected, name, designSystem, bundleUrl, props, slots } = readDraftBootstrap();
  if (expected.componentId !== id) throw new Error(`Draft capture targets ${expected.componentId}, not ${id}`);
  // Components are not theme-pinned: use the latest theme of the component's design system.
  let dsMetaVersion: number | null = null; let theme: ThemeContent | null = null;
  try { const ds = await getDesignSystemById(designSystem, signal); dsMetaVersion = ds.latestMetaVersion ?? null; theme = { tokens: ds.tokens ?? {}, fonts: ds.fonts ?? [], icons: ds.icons ?? [] }; } catch { /* theme is best-effort */ }
  return {
    id, name, rev: expected.rev, sourceHash: expected.sourceHash, bundleHash: expected.bundleHash,
    bundleUrl, designSystem, props, dsMetaVersion, theme,
    ...(slots === undefined ? {} : { slots }),
    ...(expected.slotsHash === undefined ? {} : { slotsHash: expected.slotsHash }),
  };
}

/**
 * Бандл драфта и бандлы опубликованных детей слотов грузятся **одним** вызовом загрузчика:
 * определения родителя и детей обязаны попасть в один рантайм-реестр, иначе дерево `c` + `s0…sN`
 * рендерилось бы с неизвестными типами.
 */
async function loadDraftRuntime(loaded: LoadedDraftComponent, signal: AbortSignal): Promise<CustomPlayerRuntime> {
  const result = await loadCustomComponents([
    { id: loaded.id, name: loaded.name, version: loaded.rev, bundleUrl: loaded.bundleUrl, bundleHash: loaded.bundleHash },
    ...(loaded.slots?.children ?? []).map(({ id, name, version, bundleUrl, bundleHash }) => ({ id, name, version, bundleUrl, bundleHash })),
  ]);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return result;
}

function LoadedDraftCapture({ loaded, custom }: { loaded: LoadedDraftComponent; custom: CustomPlayerRuntime }) {
  return <ComponentCaptureSurface name={loaded.name} designSystem={loaded.designSystem} theme={loaded.theme} props={loaded.props} custom={custom} slots={loaded.slots}
    readyOf={(propsHash) => ({
      status: "ready", kind: "component-draft", componentId: loaded.id, rev: loaded.rev, sourceHash: loaded.sourceHash,
      bundleHash: loaded.bundleHash, propsHash, dsMetaVersion: loaded.dsMetaVersion, rendererBuild: bootstrapRendererBuild(),
      // Эхо из frozen-bootstrap: пересчитывать нечего — пре-образ хэша живёт на сервере (§A3).
      ...(loaded.slotsHash === undefined ? {} : { slotsHash: loaded.slotsHash }),
    })} />;
}

function WithDraftComponent({ loaded }: { loaded: LoadedDraftComponent }) {
  const custom = useApi((signal) => loadDraftRuntime(loaded, signal), [loaded.id, loaded.bundleUrl]);
  usePublishError(custom.status === "error" ? errorMessage(custom.error) : null);
  if (custom.status === "loading") return <div id="eui-capture-loading" />;
  if (custom.status === "error") return <div data-capture-error="components" />;
  return <LoadedDraftCapture loaded={loaded} custom={custom.data} />;
}

export function CaptureComponentDraft() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const theme = search.get("theme") === "dark" ? "dark" : "light";
  useCaptureTheme(theme);
  const state = useApi((signal) => loadDraftComponent(id ?? "", signal), [id]);
  usePublishError(state.status === "error" ? errorMessage(state.error) : null);

  return <>
    <CaptureStyle />
    {state.status === "loading" ? <div id="eui-capture-loading" />
      : state.status === "error" ? <div data-capture-error="load" />
      : <WithDraftComponent loaded={state.data} />}
  </>;
}
