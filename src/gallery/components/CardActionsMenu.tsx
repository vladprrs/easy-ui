import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link } from "react-router";
import { ApiError, listPrototypeVersions, PROTOTYPE_KINDS, prototypeKindOf, setPrototypeLifecycle, setPrototypeStatus, type PrototypeKind, type PrototypeStatus, type PrototypeSummary, type PrototypeVersionSummary } from "../../api/client";
import { downloadBundle } from "../../api/bundles";
import { Menu, MenuGroupLabel, MenuItem, MenuSeparator, MenuSubmenu, menuItemClass, useMenuClose } from "../../app/Menu";
import { ConfirmModal, Modal } from "../../app/Modal";
import { SelectPill } from "../../app/SelectPill";
import { inputBase, inputLabel, pillGhost, pillPrimary } from "../../app/chrome";
import { common } from "../../app/strings/common";
import { gallery, versionLink } from "../../app/strings/gallery";
import { ReadinessPanel } from "../../editor/ReadinessPanel";

export interface CardActionsMenuProps {
  prototype: PrototypeSummary;
  isOwner: boolean;
  onShare: (prototypeId: string, latestVersion: number) => void;
  onChanged: () => void;
}

type LifecycleDialogState = { kind: PrototypeKind; tags: string; saving: boolean; error: boolean };
type VersionsState = { status: "idle" | "loading" | "ready" | "error"; data: PrototypeVersionSummary[] };
/** Деструктив подтверждается окном (S6); какой именно — решает эта величина. */
type ConfirmKind = "archive" | "unpublish";

/** `«tag-a, tag-b»` → ["tag-a","tag-b"]; сервер отвечает 422 на невалидные slug'и. */
export const parseTagsInput = (raw: string): string[] =>
  [...new Set(raw.split(",").map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))];

/**
 * Ссылка-пункт меню. `Link` react-router — чужой узел, поэтому `role="menuitem"`
 * и класс проставляются руками, а закрытие берётся из контекста `Menu`: без него
 * поповер оставался бы висеть поверх уже сменившегося маршрута.
 */
function MenuLink({ to, children }: { to: string; children: string }): ReactElement {
  const close = useMenuClose();
  return <Link role="menuitem" className={menuItemClass} to={to} onClick={close}>{children}</Link>;
}

/**
 * Единственное меню карточки галереи (макет 01 + 08).
 *
 * До редизайна карточка несла шесть контролов в ряд (Презентация, CJM, Редактор, QR,
 * Версии, «⋯») — они конкурировали и с самой карточкой-ссылкой, и друг с другом.
 * Теперь основной клик — сама карточка (плеер), а всё остальное лежит здесь тремя
 * группами: куда открыть · чем поделиться · что изменить.
 *
 * Оболочка — общий примитив `Menu` (W0): нативный `<details>`, которым меню было
 * раньше, не давал ни `role="menu"`, ни стрелок, ни возврата фокуса на триггер.
 */
export function CardActionsMenu({ prototype, isOwner, onShare, onChanged }: CardActionsMenuProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleDialogState | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);
  const [versions, setVersions] = useState<VersionsState>({ status: "idle", data: [] });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const { latestVersion } = prototype;

  const changeStatus = async (status: PrototypeStatus) => {
    setBusy(true);
    setError(null);
    try {
      await setPrototypeStatus(prototype.id, status);
      setBusy(false);
      setConfirmKind(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 && cause.code === "prototype_not_renderable"
        ? gallery.restoreNotRenderable
        : gallery.statusChangeFailed);
      setBusy(false);
    }
  };

  const exportUrl = (version: number | null) => `/api/prototypes/${encodeURIComponent(prototype.id)}/export${version === null ? "" : `?version=${version}`}`;
  const exportName = (version: number | null) => `easy-ui-prototype-${prototype.id}-${version === null ? "draft" : `v${version}`}.zip`;
  const runExport = async (key: string, version: number | null) => {
    setDownloading(key);
    setExportError(null);
    try {
      await downloadBundle(exportUrl(version), exportName(version));
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : gallery.exportError);
    } finally {
      setDownloading(null);
    }
  };

  // Версии — единственный запрос этого меню; он уходит при раскрытии любого из
  // двух подменю («Версии» и «Скачать…»), но выполняется однократно.
  const loadVersions = () => {
    if (versions.status === "loading" || versions.status === "ready") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setVersions((current) => ({ status: "loading", data: current.data }));
    void listPrototypeVersions(prototype.id, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setVersions({ status: "ready", data }); },
      () => { if (!controller.signal.aborted) setVersions((current) => ({ status: "error", data: current.data })); },
    );
  };

  const openLifecycle = () => {
    setLifecycle({ kind: prototypeKindOf(prototype), tags: (prototype.tags ?? []).join(", "), saving: false, error: false });
  };
  const submitLifecycle = async () => {
    if (!lifecycle || lifecycle.saving) return;
    setLifecycle({ ...lifecycle, saving: true, error: false });
    try {
      await setPrototypeLifecycle(prototype.id, { kind: lifecycle.kind, tags: parseTagsInput(lifecycle.tags) });
      setLifecycle(null);
      onChanged();
    } catch {
      setLifecycle((current) => current ? { ...current, saving: false, error: true } : null);
    }
  };

  /** Статус загрузки версий, общий для обоих подменю. */
  const versionsStatus = <>
    {versions.status === "idle" || versions.status === "loading" ? <p className="px-3 py-1 text-xs text-eui-slate-500" aria-live="polite">{gallery.versionsLoading}</p> : null}
    {versions.status === "error" ? <>
      <p role="alert" className="px-3 py-1 text-xs text-pay-red">{gallery.versionsLoadFailed}</p>
      <button type="button" className={`${pillGhost} mx-3 my-1`} onClick={loadVersions}>{common.retry}</button>
    </> : null}
    {versions.status === "ready" && !versions.data.length ? <p className="px-3 py-1 text-xs text-eui-slate-500">{gallery.noVersions}</p> : null}
  </>;

  return <>
    <Menu label={gallery.overflowActionsAria} locked={busy}>
      <MenuGroupLabel>{gallery.menuGroupOpen}</MenuGroupLabel>
      <MenuLink to={`/p/${prototype.id}`}>{gallery.playerLink}</MenuLink>
      <MenuLink to={`/p/${prototype.id}/cjm`}>{gallery.cjmLink}</MenuLink>
      <MenuLink to={`/p/${prototype.id}/present`}>{gallery.presentLink}</MenuLink>
      {isOwner ? <MenuLink to={`/p/${prototype.id}/edit`}>{gallery.editorLink}</MenuLink> : null}
      {isOwner || latestVersion !== null ? <>
        <MenuSeparator />
        <MenuGroupLabel>{gallery.menuGroupShare}</MenuGroupLabel>
        {isOwner && latestVersion !== null
          ? <MenuItem closeOnSelect onSelect={() => onShare(prototype.id, latestVersion)}>{gallery.qrOnPhone}</MenuItem>
          : null}
        {latestVersion !== null ? <MenuSubmenu label={gallery.versionsMenu} onOpen={loadVersions}>
          {versionsStatus}
          {versions.status === "ready" ? versions.data.map((version) => <MenuLink key={version.version} to={`/p/${prototype.id}/v/${version.version}`}>{versionLink(version.version)}</MenuLink>) : null}
        </MenuSubmenu> : null}
        {/* Один вход вместо трёх пунктов экспорта: что скачиваем — выбор внутри. */}
        <MenuSubmenu label={gallery.downloadMenu} onOpen={loadVersions}>
          {isOwner ? <MenuItem disabled={downloading !== null} onSelect={() => void runExport("draft", null)}>
            {downloading === "draft" ? gallery.exporting : gallery.downloadDraft}
          </MenuItem> : null}
          {latestVersion !== null ? <>
            {versionsStatus}
            {versions.status === "ready" ? versions.data.map((version) => <MenuItem
              key={version.version}
              disabled={downloading !== null}
              onSelect={() => void runExport(`v${version.version}`, version.version)}
            >{downloading === `v${version.version}` ? gallery.exporting : gallery.downloadVersion(version.version)}</MenuItem>) : null}
          </> : null}
        </MenuSubmenu>
      </> : null}
      {isOwner ? <>
        <MenuSeparator />
        <MenuGroupLabel>{gallery.menuGroupManage}</MenuGroupLabel>
        {prototype.status === "private" ? <MenuItem closeOnSelect disabled={busy} onSelect={() => setPublishOpen(true)}>{gallery.publish}</MenuItem> : null}
        {prototype.status === "published" ? <MenuItem closeOnSelect destructive disabled={busy} onSelect={() => setConfirmKind("unpublish")}>{gallery.unpublish}</MenuItem> : null}
        {prototype.status !== "archived" ? <MenuItem closeOnSelect destructive disabled={busy} onSelect={() => setConfirmKind("archive")}>{gallery.archive}</MenuItem> : null}
        {prototype.status === "archived" ? <MenuItem disabled={busy} onSelect={() => void changeStatus("private")}>{gallery.restore}</MenuItem> : null}
        <MenuItem closeOnSelect disabled={busy} onSelect={openLifecycle}>{gallery.lifecycleAction}</MenuItem>
      </> : null}
    </Menu>
    {confirmKind ? <ConfirmModal
      title={confirmKind === "archive" ? gallery.archiveConfirmTitle : gallery.unpublishConfirmTitle}
      body={confirmKind === "archive" ? gallery.archiveConfirmBody : gallery.unpublishConfirmBody}
      confirmLabel={confirmKind === "archive" ? gallery.archiveConfirm : gallery.unpublishConfirm}
      cancelLabel={gallery.cancel}
      busyLabel={gallery.statusChanging}
      busy={busy}
      error={error ?? undefined}
      onConfirm={() => void changeStatus(confirmKind === "archive" ? "archived" : "private")}
      onClose={() => { setConfirmKind(null); setError(null); }}
    /> : null}
    {publishOpen ? <Modal
      title={gallery.publishDialogTitle}
      onClose={() => setPublishOpen(false)}
      className="text-left"
      footer={<>
        <button type="button" className={pillGhost} disabled={busy} onClick={() => setPublishOpen(false)}>{gallery.cancel}</button>
        <button type="button" className={pillPrimary} disabled={busy} onClick={() => void changeStatus("published").then(() => setPublishOpen(false))}>{busy ? gallery.publishing : gallery.publishConfirm}</button>
      </>}
    >
      <p className="mt-1 text-sm text-eui-slate-500">{gallery.publishDialogBody}</p>
      <div className="-mx-7 mt-5 border-y border-pay-lavender"><ReadinessPanel prototypeId={prototype.id} /></div>
      {error ? <p role="alert" className="mt-3 text-sm text-pay-red">{error}</p> : null}
    </Modal> : null}
    {lifecycle ? <Modal
      title={gallery.lifecycleDialogTitle}
      onClose={() => setLifecycle(null)}
      className="text-left"
    >
      <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submitLifecycle(); }}>
        <div className="grid gap-1.5">
          <span className={inputLabel}>{gallery.kindLabel}</span>
          <SelectPill
            label={gallery.kindLabel}
            value={lifecycle.kind}
            disabled={lifecycle.saving}
            onChange={(next) => setLifecycle((current) => current ? { ...current, kind: next as PrototypeKind, error: false } : null)}
            options={PROTOTYPE_KINDS.map((kind) => ({ value: kind, label: gallery.kindNames[kind] ?? kind }))}
          />
        </div>
        <label className={inputLabel}>{gallery.lifecycleTagsLabel}
          <input className={`${inputBase} mt-1.5 w-full`} value={lifecycle.tags} disabled={lifecycle.saving}
            onChange={(event) => setLifecycle((current) => current ? { ...current, tags: event.target.value, error: false } : null)} />
        </label>
        <p className="text-xs text-eui-slate-500">{gallery.lifecycleTagsHint}</p>
        {lifecycle.error ? <p role="alert" className="text-sm text-pay-red">{gallery.lifecycleFailed}</p> : null}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className={pillGhost} disabled={lifecycle.saving} onClick={() => setLifecycle(null)}>{gallery.cancel}</button>
          <button type="submit" className={pillPrimary} disabled={lifecycle.saving}>{lifecycle.saving ? gallery.lifecycleSaving : gallery.lifecycleSave}</button>
        </div>
      </form>
    </Modal> : null}
    {busy && !confirmKind ? <span role="status" className="self-center text-xs text-eui-slate-500">{gallery.statusChanging}</span> : null}
    {error && !confirmKind && !publishOpen ? <p role="alert" className="basis-full text-xs text-pay-red">{error}</p> : null}
    {exportError ? <p role="alert" className="basis-full text-xs text-pay-red">{exportError}</p> : null}
  </>;
}
