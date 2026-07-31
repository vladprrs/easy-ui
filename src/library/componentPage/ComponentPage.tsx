import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import {
  ApiError,
  getComponentUsages,
  getComponentVersion,
  getDesignSystemById,
  type ApiErrorBody,
  type ComponentMeta,
  type ComponentStatus,
  type ComponentVersion,
  type ThemeContent,
} from "../../api/client";
import { downloadBundle } from "../../api/bundles";
import { chip, chipActive, headingPage, inputBase, kicker, kickerOnDark, pillGhost, pillPrimary } from "../../app/chrome";
import { ErrorState as StateError, Skeleton } from "../../app/states";
import { componentPage as strings, componentStatusLabels } from "../../app/strings/componentPage";
import { useDocumentTitle } from "../../app/useDocumentTitle";
import type { CustomPlayerRuntime } from "../../catalog/runtime";
import { FullDocumentReloadRequiredError, loadCustomComponents } from "../../customComponents/loader";
import { SurfaceSpacingScope } from "../../designSystems/SurfaceSpacingScope";
import { ThemeStyle } from "../../designSystems/theme";
import { PropsForm, validateZodCandidate, type PropsValidation } from "../../propsForm";
import { RuntimePreview, usePreviewRuntime } from "../preview/renderPreview";
import { EventsSection, MetaSection, PropsTable, SlotsSection, SourceView } from "../componentDocs";
import { PreviewErrorBoundary } from "./PreviewErrorBoundary";
import {
  initialCandidate,
  parseVersionQuery,
  renderableStatuses,
  resolveSelectedVersion,
  statusForVersion,
} from "./model";
import { useKeyedRequest, type KeyedRequestState } from "./useKeyedRequest";
import { UsageTree } from "../UsageTree";

async function componentMetaNoStore(id: string, signal: AbortSignal): Promise<ComponentMeta> {
  const response = await fetch(`/api/components/${encodeURIComponent(id)}`, { signal, cache: "no-store" });
  if (response.ok) return await response.json() as ComponentMeta;
  let body: ApiErrorBody = { code: "http_error", message: `Не удалось выполнить запрос к API (${response.status})` };
  try {
    const value = await response.json() as { error?: ApiErrorBody };
    if (value.error?.code && value.error.message) body = value.error;
  } catch { /* Keep the stable API fallback. */ }
  throw new ApiError(response.status, body);
}

function errorIs404(error: unknown): boolean { return error instanceof ApiError && error.status === 404; }

/**
 * Ошибка и загрузка страницы компонента — общие примитивы `app/states.tsx`.
 * Пять мест на странице держали пять разных плашек «Загружаем…»; теперь у всех
 * один ритм скелетона и одна геометрия, а различается только подпись.
 */
function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <StateError title={message} retryLabel={strings.retry} onRetry={retry} />;
}

function LoadingState({ label }: { label: string }) {
  return <Skeleton label={label} count={1} previewHeight={120} gridClassName="grid gap-5" />;
}

export function ComponentPage() {
  const { componentId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const queryText = search.toString();
  const query = useMemo(() => parseVersionQuery(new URLSearchParams(queryText)), [queryText]);
  const metaKey = componentId && query.kind !== "invalid" ? `meta:${componentId}` : null;
  const meta = useKeyedRequest(metaKey, (signal) => componentMetaNoStore(componentId, signal));
  const selectedVersion = meta.status === "ready" ? resolveSelectedVersion(meta.data, query) : null;
  const versionKey = selectedVersion === null ? null : `${componentId}@${selectedVersion}`;
  const version = useKeyedRequest(versionKey, (signal) => getComponentVersion(componentId, selectedVersion!, signal));
  const loadedVersion = version.status === "ready" ? version.data : null;
  const versionStatus = meta.status === "ready" && selectedVersion !== null ? statusForVersion(meta.data, selectedVersion) : undefined;
  const canExecute = versionStatus !== undefined && renderableStatuses.has(versionStatus.status);
  const theme = useKeyedRequest(loadedVersion ? `theme:${versionKey}` : null, async (signal) => {
    if (!loadedVersion) throw new Error("Version is not loaded");
    const system = await getDesignSystemById(loadedVersion.designSystem, signal);
    return { tokens: system.tokens ?? {}, fonts: system.fonts ?? [], icons: system.icons ?? [] } satisfies ThemeContent;
  });
  const bundle = useKeyedRequest(loadedVersion && canExecute ? `bundle:${versionKey}` : null, async (signal) => {
    if (!loadedVersion) throw new Error("Version is not loaded");
    const loaded = await loadCustomComponents([{
      id: componentId,
      name: meta.status === "ready" ? meta.data.name : loadedVersion.name ?? componentId,
      version: loadedVersion.version,
      bundleUrl: `/api/components/${encodeURIComponent(componentId)}/versions/${loadedVersion.version}/bundle.js`,
      bundleHash: loadedVersion.bundleHash,
    }]);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return loaded;
  });
  const [activeTab, setActiveTab] = useState(0);

  useDocumentTitle(meta.status === "ready" ? `${meta.data.name} · ${strings.title}` : strings.title);

  if (query.kind === "invalid") return <PageFrame><h1 className={headingPage}>{strings.invalidAddress}</h1></PageFrame>;
  if (meta.status === "loading" || meta.status === "idle") return <PageFrame><LoadingState label={strings.loadingMeta} /></PageFrame>;
  if (meta.status === "error") return <PageFrame><ErrorState message={errorIs404(meta.error) ? strings.componentNotFound : strings.metaError} retry={meta.reload} /></PageFrame>;
  if (selectedVersion === null) return <NoRenderableVersions meta={meta.data} onSelect={(value) => setSearch({ v: String(value) })} />;

  const statusLabel = versionStatus ? componentStatusLabels[versionStatus.status] : componentStatusLabels.staging;
  return <PageFrame>
    <header className="flex flex-wrap items-end gap-4">
      <div className="min-w-0 flex-1">
        <p className={kicker}>{strings.title}</p>
        <h1 className={`${headingPage} mt-1 truncate`}>{meta.data.name}</h1>
      </div>
      <label className="text-sm font-medium text-eui-slate-500">{strings.versionSelector}
        <select className={`${inputBase} ml-2 bg-white text-eui-ink`} value={selectedVersion} onChange={(event) => setSearch({ v: event.target.value })}>
          {!meta.data.versions.some((entry) => entry.version === selectedVersion) ? <option value={selectedVersion}>v{selectedVersion}</option> : null}
          {[...meta.data.versions].sort((a, b) => b.version - a.version).map((entry) =>
            <option key={entry.version} value={entry.version}>v{entry.version} — {componentStatusLabels[entry.status]}</option>)}
        </select>
      </label>
      <ExportButton componentId={componentId} version={selectedVersion} />
    </header>
    <p className="sr-only" aria-live="polite">{strings.statusAnnouncement(selectedVersion, statusLabel)}</p>

    {version.status === "loading" || version.status === "idle" ? <LoadingState label={strings.loadingVersion} />
      : version.status === "error" ? <ErrorState message={errorIs404(version.error) ? strings.versionNotFound : strings.versionError} retry={version.reload} />
      : <>
        <Tabs active={activeTab} onChange={setActiveTab} />
        <section role="tabpanel" id="component-panel-0" aria-labelledby="component-tab-0" hidden={activeTab !== 0}>
          <ComponentTab
            componentId={componentId}
            componentName={meta.data.name}
            requestKey={versionKey!}
            version={version.data}
            status={versionStatus?.status}
            canExecute={canExecute}
            theme={theme}
            bundle={bundle}
          />
        </section>
        <section className="space-y-7 rounded-panel bg-eui-lav p-6" role="tabpanel" id="component-panel-1" aria-labelledby="component-tab-1" hidden={activeTab !== 1}>
          <PropsTable schema={version.data.propsJsonSchema} />
          <EventsSection events={version.data.events} eventPayloads={version.data.eventPayloads} />
          <SlotsSection slots={version.data.slots} />
          <MetaSection meta={version.data} />
        </section>
        <section className="rounded-panel bg-eui-ink p-6 text-sm text-white" role="tabpanel" id="component-panel-2" aria-labelledby="component-tab-2" hidden={activeTab !== 2}>
          <ProvenanceBlock version={version.data} />
          <SourceView source={version.data.source} />
        </section>
        <section className="rounded-panel bg-eui-lav p-6" role="tabpanel" id="component-panel-3" aria-labelledby="component-tab-3" hidden={activeTab !== 3}>
          <UsagesTab componentId={componentId} active={activeTab === 3} />
        </section>
      </>}
  </PageFrame>;
}

function PageFrame({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-full max-w-screen-2xl flex-col gap-5 px-5 py-7 font-eui-ui md:px-8">{children}</main>;
}

function ExportButton({ componentId, version }: { componentId: string; version: number | null }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onExport = async () => {
    setDownloading(true);
    setError(null);
    const query = version === null ? "" : `?version=${version}`;
    const fallbackName = `easy-ui-component-${componentId}-${version === null ? "draft" : `v${version}`}.zip`;
    try {
      await downloadBundle(`/api/components/${encodeURIComponent(componentId)}/export${query}`, fallbackName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : strings.exportError);
    } finally {
      setDownloading(false);
    }
  };
  return <div className="flex flex-col items-start gap-1">
    <button type="button" className={pillGhost} onClick={onExport} disabled={downloading}>
      {downloading ? strings.exporting : strings.exportVersion}
    </button>
    {error ? <span role="alert" className="text-xs text-pay-red">{error}</span> : null}
  </div>;
}

function NoRenderableVersions({ meta, onSelect }: { meta: ComponentMeta; onSelect: (version: number) => void }) {
  useDocumentTitle(`${meta.name} · ${strings.title}`);
  return <PageFrame>
    <p className={kicker}>{strings.title}</p>
    <h1 className={headingPage}>{meta.name}</h1>
    <section className="rounded-panel bg-eui-lav p-6">
      <h2 className="pay-display text-2xl">{strings.noRenderableVersions}</h2>
      <p className="mt-2 text-sm text-eui-slate-500">{strings.noRenderableVersionsBody}</p>
      <h3 className="mt-5 font-bold">{strings.versionsTitle}</h3>
      <ul className="mt-2 space-y-2">{[...meta.versions].sort((a, b) => b.version - a.version).map((entry) => <li key={entry.version}>
        <button type="button" className={pillGhost} onClick={() => onSelect(entry.version)}>v{entry.version} — {componentStatusLabels[entry.status]}</button>
      </li>)}</ul>
    </section>
  </PageFrame>;
}

function Tabs({ active, onChange }: { active: number; onChange: (index: number) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (current + 1) % strings.tabs.length;
    if (event.key === "ArrowLeft") next = (current - 1 + strings.tabs.length) % strings.tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = strings.tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };
  return <div role="tablist" aria-label={strings.title} className="flex flex-wrap gap-2">
    {strings.tabs.map((label, index) => <button
      ref={(node) => { refs.current[index] = node; }}
      type="button"
      role="tab"
      id={`component-tab-${index}`}
      aria-controls={`component-panel-${index}`}
      aria-selected={active === index}
      tabIndex={active === index ? 0 : -1}
      className={active === index ? chipActive : chip}
      onClick={() => onChange(index)}
      onKeyDown={(event) => selectFromKeyboard(event, index)}
      key={label}
    >{label}</button>)}
  </div>;
}

/**
 * Блок происхождения рядом с активным исходником (волна 3 §3.3): архитектурные метаданные
 * волны 2 объясняют, чем компонент владеет и почему — это ровно тот контекст, который
 * нужен читателю кода.
 */
function ProvenanceBlock({ version }: { version: ComponentVersion }) {
  const rows: [string, string][] = [
    [strings.provenanceSource, `v${version.version} · rev ${version.rev} · ${version.designSystem}`],
    [strings.provenanceScope, version.scope ?? strings.provenanceNotSet],
    [strings.provenanceCanonicalFor, version.canonicalFor?.length ? version.canonicalFor.join(", ") : strings.provenanceNotSet],
    [strings.provenanceSourceBounded, version.sourceBounded === undefined ? strings.provenanceNotSet : String(version.sourceBounded)],
    ...(version.replacement ? [[strings.provenanceReplacement, version.replacement] as [string, string]] : []),
  ];
  return <section aria-labelledby="component-provenance-title" className="mb-5 rounded-popover bg-white/5 p-4">
    <h2 id="component-provenance-title" className={kickerOnDark}>{strings.provenanceTitle}</h2>
    <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
      {rows.map(([label, value]) => <div key={label}><dt className="text-eui-ondark-2">{label}</dt><dd className="mt-0.5 font-medium">{value}</dd></div>)}
    </dl>
    {version.ownership?.reason ? <p className="mt-3 text-xs"><span className="text-eui-ondark-2">{strings.provenanceOwnership}: </span>{version.ownership.reason}{version.ownership.provenance ? ` (${version.ownership.provenance})` : ""}</p> : null}
  </section>;
}

/** Вкладка «Usages»: граф использования компонента, загружается по открытию вкладки. */
function UsagesTab({ componentId, active }: { componentId: string; active: boolean }) {
  const usages = useKeyedRequest(active ? `usages:${componentId}` : null, (signal) => getComponentUsages(componentId, signal));
  if (usages.status === "loading" || usages.status === "idle") return <LoadingState label={strings.usagesLoading} />;
  if (usages.status === "error") return <ErrorState message={strings.usagesError} retry={usages.reload} />;
  const report = usages.data;
  return <div className="space-y-5">
    <h2 className="pay-display text-xl">{strings.usagesTitle}</h2>
    <p className="text-sm text-eui-slate-500">{strings.usagesVersionsInUse}: {report.versionsInUse.length ? report.versionsInUse.map((value) => `v${value}`).join(", ") : "—"}</p>
    <section aria-labelledby="component-usages-head-title">
      <h3 id="component-usages-head-title" className={kicker}>{strings.usagesHead}</h3>
      {report.currentHeadUsages.length
        ? <UsageTree usages={report.currentHeadUsages} />
        : <p className="mt-2 text-sm text-eui-slate-500">{report.safeToRemove ? strings.usagesSafeToRemove : strings.usagesNone}</p>}
    </section>
    {report.immutableUsages.length ? <section aria-labelledby="component-usages-immutable-title">
      <h3 id="component-usages-immutable-title" className={kicker}>{strings.usagesImmutable}</h3>
      <ul className="mt-2 space-y-1 text-sm text-eui-slate-500">{report.immutableUsages.map((usage) => <li key={`${usage.prototypeId}@${usage.version}`}>{usage.name} · v{usage.version} → {strings.versionSelector} {usage.componentVersion}</li>)}</ul>
    </section> : null}
  </div>;
}

type ComponentTabProps = {
  componentId: string;
  componentName: string;
  requestKey: string;
  version: ComponentVersion;
  status: ComponentStatus | undefined;
  canExecute: boolean;
  theme: KeyedRequestState<ThemeContent>;
  bundle: KeyedRequestState<CustomPlayerRuntime>;
};

function ComponentTab({ componentId, componentName, requestKey, version, status, canExecute, theme, bundle }: ComponentTabProps) {
  if (!canExecute) {
    const label = status ? componentStatusLabels[status] : componentStatusLabels.staging;
    return <div role="note" className="rounded-panel bg-eui-lav p-6">
      <h2 className="pay-display text-xl">{strings.executionForbidden}</h2>
      <p className="mt-2 text-sm text-eui-slate-500">{strings.executionForbiddenBody(label)}</p>
    </div>;
  }
  if (bundle.status === "loading" || bundle.status === "idle") return <LoadingState label={strings.loadingBundle} />;
  if (bundle.status === "error") {
    const reloadRequired = bundle.error instanceof FullDocumentReloadRequiredError;
    return <div role="alert" className="rounded-panel bg-eui-lav p-6 text-sm text-eui-slate-500">
      <p>{reloadRequired ? strings.reloadRequired : strings.bundleError}</p>
      <button type="button" className={`${reloadRequired ? pillPrimary : pillGhost} mt-3`} onClick={reloadRequired ? () => window.location.reload() : bundle.reload}>
        {reloadRequired ? strings.reloadPage : strings.retry}
      </button>
    </div>;
  }
  return <ShowcaseRuntime
    key={requestKey}
    componentId={componentId}
    componentName={componentName}
    requestKey={requestKey}
    version={version}
    loaded={bundle.data}
    theme={theme}
  />;
}

function ShowcaseRuntime({ componentName, requestKey, version, loaded, theme }: {
  componentId: string;
  componentName: string;
  requestKey: string;
  version: ComponentVersion;
  loaded: CustomPlayerRuntime;
  theme: KeyedRequestState<ThemeContent>;
}) {
  const schema = loaded.definitions[componentName]?.props;
  const firstCandidate = useMemo(() => initialCandidate(version), [version]);
  const firstValidation = useMemo(() => schema ? validateZodCandidate(schema, firstCandidate) : ({ ok: false, fields: {}, form: strings.runtimeError } as PropsValidation), [firstCandidate, schema]);
  const [draftProps, setDraftProps] = useState(firstCandidate);
  const [previewProps, setPreviewProps] = useState<Record<string, unknown> | null>(() => firstValidation.ok ? firstCandidate : null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [darkBackground, setDarkBackground] = useState(false);
  const [boundaryErrored, setBoundaryErrored] = useState(false);
  const [runtimeReportedError, setRuntimeReportedError] = useState(false);
  const [resetGeneration, setResetGeneration] = useState(0);
  const runtime = usePreviewRuntime(loaded, () => setRuntimeReportedError(true));
  const presets = useMemo(() => [
    ...(version.example ? [{ name: strings.defaultPreset, value: version.example }] : []),
    ...Object.entries(version.examples ?? {}).map(([name, value]) => ({ name, value })),
  ].map((preset) => ({ ...preset, validation: schema ? validateZodCandidate(schema, preset.value) : ({ ok: false, fields: {} } as PropsValidation) })), [schema, version.example, version.examples]);

  if (!schema) return <ErrorState message={strings.runtimeError} retry={() => window.location.reload()} />;

  const acceptCandidate = (candidate: Record<string, unknown>, validation: PropsValidation) => {
    setDraftProps(candidate);
    if (!validation.ok) return;
    setPreviewProps(candidate); // Deliberately raw input, never safeParse(...).data.
    if (boundaryErrored) {
      setRuntimeReportedError(false);
      setResetGeneration((value) => value + 1);
    }
  };
  const applyPreset = (preset: { value: Record<string, unknown>; validation: PropsValidation }) => {
    if (!preset.validation.ok) return;
    setDraftProps(preset.value);
    setPreviewProps(preset.value);
    setFormEpoch((value) => value + 1);
    if (boundaryErrored) {
      setRuntimeReportedError(false);
      setResetGeneration((value) => value + 1);
    }
  };

  return <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
    <section aria-labelledby="component-preview-title" className="min-w-0 rounded-panel bg-eui-lav p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 id="component-preview-title" className="mr-auto pay-display text-xl">{strings.previewTitle}</h2>
        <span className="text-xs text-eui-slate-500">{strings.backgroundTitle}</span>
        <button type="button" aria-pressed={!darkBackground} className={!darkBackground ? chipActive : chip} onClick={() => setDarkBackground(false)}>{strings.lightBackground}</button>
        <button type="button" aria-pressed={darkBackground} className={darkBackground ? chipActive : chip} onClick={() => setDarkBackground(true)}>{strings.darkBackground}</button>
      </div>
      {theme.status === "loading" || theme.status === "idle" ? <LoadingState label={strings.loadingTheme} /> : null}
      {theme.status === "error" ? <div className="mb-3"><ErrorState message={strings.themeError} retry={theme.reload} /></div> : null}
      <SurfaceSpacingScope systemId={version.designSystem} themeTokens={theme.status === "ready" ? theme.data.tokens : undefined}>
        <div className="contents">
          <ThemeStyle content={theme.status === "ready" ? theme.data : null} />
          <div className={`flex min-h-72 items-center justify-center overflow-auto rounded-popover p-6 transition-colors ${darkBackground ? "bg-eui-ink" : "bg-white"}`}>
            {theme.status === "loading" || theme.status === "idle" ? null
              : previewProps === null ? <p className={darkBackground ? "text-white" : "text-eui-slate-500"}>{strings.requiredProps}</p>
              : <PreviewErrorBoundary key={requestKey} resetGeneration={resetGeneration} reportedError={runtimeReportedError} onErrorStateChange={setBoundaryErrored} fallback={<StateError title={strings.previewCrashed} />}>
                <RuntimePreview componentName={componentName} designSystem={version.designSystem} source={version} props={previewProps} runtime={runtime} onError={() => setRuntimeReportedError(true)} />
              </PreviewErrorBoundary>}
          </div>
        </div>
      </SurfaceSpacingScope>
    </section>
    <aside aria-labelledby="component-controls-title" className="min-w-0 rounded-panel bg-eui-lav p-5">
      <h2 id="component-controls-title" className="pay-display text-xl">{strings.controlsTitle}</h2>
      {presets.length ? <div className="mt-4">
        <p className={kicker}>{strings.presetsTitle}</p>
        <div className="mt-2 flex flex-wrap gap-2">{presets.map((preset) => <button
          type="button"
          className={chip}
          key={preset.name}
          disabled={!preset.validation.ok}
          title={preset.validation.ok ? undefined : strings.invalidPreset}
          onClick={() => applyPreset(preset)}
        >{preset.name}</button>)}</div>
      </div> : null}
      <div className="mt-5"><AccessiblePropsForm>
        <PropsForm schema={schema} values={draftProps} epoch={formEpoch} validate={(candidate) => validateZodCandidate(schema, candidate)} onCandidate={acceptCandidate} />
      </AccessiblePropsForm></div>
    </aside>
  </div>;
}

function AccessiblePropsForm({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const controls = ref.current?.querySelectorAll<HTMLElement>("input, select, textarea") ?? [];
    controls.forEach((control, index) => {
      const field = control.closest("label")?.parentElement;
      const error = field?.querySelector<HTMLElement>("[role='alert']");
      if (!error) { control.removeAttribute("aria-describedby"); return; }
      error.id ||= `component-props-error-${index}`;
      control.setAttribute("aria-describedby", error.id);
    });
  });
  return <div ref={ref}>{children}</div>;
}
