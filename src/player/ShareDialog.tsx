import { useEffect, useState } from "react";
import { Link } from "react-router";
import { QRCodeSVG } from "qrcode.react";
import { Modal } from "../app/Modal";
import { SelectPill } from "../app/SelectPill";
import { inputBase, inputLabel, pillGhost, pillPrimary } from "../app/chrome";
import { common } from "../app/strings/common";
import { share as shareStrings } from "../app/strings/player";
import { createPrototypeShare, listPrototypeShares, revokePrototypeShare, type CreatedShareGrant, type ShareGrant } from "../api/shareApi";

const shareTtlOptions = [
  { seconds: 24 * 60 * 60, label: shareStrings.ttlDay },
  { seconds: 7 * 24 * 60 * 60, label: shareStrings.ttlWeek },
  { seconds: 30 * 24 * 60 * 60, label: shareStrings.ttlMonth },
] as const;

/**
 * Состояние списка опубликованных версий. Приходит снаружи целиком, а не тремя
 * булевыми пропсами: у диалога один корпус, и «грузим / не смогли / пусто /
 * готово» — это ровно одна ветвящаяся величина.
 */
export type ShareVersionsState =
  | { status: "loading" }
  | { status: "error"; onRetry: () => void }
  | { status: "ready"; versions: readonly { version: number }[] };

export interface ShareDialogProps {
  prototypeId: string;
  versions: ShareVersionsState;
  currentVersion?: number;
  onClose: () => void;
}

export function ShareDialog({ prototypeId, versions, currentVersion, onClose }: ShareDialogProps) {
  const ready = versions.status === "ready" ? versions.versions : [];
  const latest = ready.reduce((value, item) => Math.max(value, item.version), 0);
  // Версия выбирается лениво: список приходит асинхронно, поэтому «ничего не
  // выбрано» и «выбрана нулевая версия» обязаны различаться.
  const [picked, setPicked] = useState<number | null>(null);
  const version = picked ?? (currentVersion && ready.some((item) => item.version === currentVersion) ? currentVersion : latest);
  const [ttlSeconds, setTtlSeconds] = useState<number>(shareTtlOptions[1].seconds);
  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [created, setCreated] = useState<CreatedShareGrant | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listPrototypeShares(prototypeId, controller.signal).then(
      ({ shares }) => { setGrants(shares); setLoading(false); },
      () => { if (!controller.signal.aborted) { setError(shareStrings.loadError); setLoading(false); } },
    );
    return () => controller.abort();
  }, [prototypeId]);

  const create = async () => {
    setSubmitting(true); setError(null); setCopied(false);
    try {
      const next = await createPrototypeShare(prototypeId, version, ttlSeconds);
      setCreated(next);
      setGrants((items) => [next, ...items.filter((item) => item.id !== next.id)]);
    } catch { setError(shareStrings.createError); }
    finally { setSubmitting(false); }
  };
  const copy = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); setCopied(true); }
    catch { setCopied(false); }
  };
  const revoke = async (id: string) => {
    setError(null);
    try {
      await revokePrototypeShare(prototypeId, id);
      setGrants((items) => items.filter((item) => item.id !== id));
      if (created?.id === id) setCreated(null);
    } catch { setError(shareStrings.revokeError); }
  };
  const expires = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  return <Modal title={shareStrings.dialogTitle} closeLabel={shareStrings.close} onClose={onClose} className="max-h-[90vh] overflow-y-auto">
    {versions.status === "loading"
      ? <p className="mt-5 text-sm text-eui-slate-500" aria-live="polite">{shareStrings.versionsLoading}</p>
      : null}
    {versions.status === "error" ? <div className="mt-5">
      <p role="alert" className="text-sm text-pay-red">{shareStrings.versionsLoadFailed}</p>
      <button type="button" className={`${pillGhost} mt-3`} onClick={versions.onRetry}>{common.retry}</button>
    </div> : null}
    {/* Пустое состояние было тупиком: сообщение без выхода. Публикация версии —
        единственное, что делает ссылку возможной, поэтому она и стоит primary. */}
    {versions.status === "ready" && ready.length === 0 ? <div className="mt-5">
      <p className="text-sm text-eui-slate-500">{shareStrings.versionsEmpty}</p>
      <p className="mt-1 text-[13px] text-eui-slate-500">{shareStrings.versionsEmptyHint}</p>
      <Link className={`${pillPrimary} mt-5`} to={`/p/${prototypeId}/edit`}>{shareStrings.versionsPublishCta}</Link>
    </div> : null}

    {ready.length > 0 ? <>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <span className={inputLabel}>{shareStrings.version}</span>
          <SelectPill
            label={shareStrings.version}
            value={String(version)}
            onChange={(next) => setPicked(Number(next))}
            options={[...ready].sort((a, b) => b.version - a.version).map((item) => ({ value: String(item.version), label: `v${item.version}` }))}
          />
        </div>
        <div className="grid gap-1.5">
          <span className={inputLabel}>{shareStrings.ttl}</span>
          <SelectPill
            label={shareStrings.ttl}
            value={String(ttlSeconds)}
            onChange={(next) => setTtlSeconds(Number(next))}
            options={shareTtlOptions.map((item) => ({ value: String(item.seconds), label: item.label }))}
          />
        </div>
      </div>
      <button type="button" className={`${pillPrimary} mt-5`} disabled={submitting} onClick={() => { void create(); }}>{submitting ? shareStrings.creating : shareStrings.create}</button>
    </> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-pay-red">{error}</p> : null}

    {created ? <section aria-label={shareStrings.createdLabel} className="mt-6 rounded-inset bg-pay-lavender p-4">
      <h3 className="text-sm font-medium">{shareStrings.createdLabel}</h3>
      <div className="mt-3 flex gap-2">
        <input className={`${inputBase} min-w-0 flex-1`} value={created.url} readOnly aria-label={shareStrings.createdLabel} />
        <button type="button" className={pillGhost} onClick={() => { void copy(); }}>{copied ? shareStrings.copied : shareStrings.copy}</button>
      </div>
      <div className="mt-4 flex justify-center rounded-inset bg-white p-4">
        <QRCodeSVG value={created.url} size={180} marginSize={1} role="img" aria-label={shareStrings.qrLabel} />
      </div>
    </section> : null}

    <section className="mt-6" aria-labelledby="active-shares-title">
      <h3 id="active-shares-title" className="text-sm font-medium">{shareStrings.activeTitle}</h3>
      {loading ? <p className="mt-2 text-sm text-eui-slate-500">{shareStrings.loading}</p>
        : grants.length === 0 ? <p className="mt-2 text-sm text-eui-slate-500">{shareStrings.activeEmpty}</p>
          : <ul className="mt-3 grid gap-2">{grants.map((grant) => <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-inset bg-pay-lavender-tint px-4 py-3">
            <span><span className="block text-sm font-medium">{shareStrings.activeItem(grant.version, expires(grant.expiresAt))}</span><span className="text-xs text-eui-slate-500">{shareStrings.sessions(grant.activeSessions)}</span></span>
            <button type="button" className={pillGhost} onClick={() => { void revoke(grant.id); }}>{shareStrings.revoke}</button>
          </li>)}</ul>}
    </section>
  </Modal>;
}
