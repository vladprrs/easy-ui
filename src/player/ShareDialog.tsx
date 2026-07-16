import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { inputBase, pillGhost, pillPrimary } from "../app/chrome";
import { share as shareStrings } from "../app/strings/player";
import { createPrototypeShare, listPrototypeShares, revokePrototypeShare, type CreatedShareGrant, type ShareGrant } from "../api/shareApi";

const shareTtlOptions = [
  { seconds: 24 * 60 * 60, label: shareStrings.ttlDay },
  { seconds: 7 * 24 * 60 * 60, label: shareStrings.ttlWeek },
  { seconds: 30 * 24 * 60 * 60, label: shareStrings.ttlMonth },
] as const;

export function ShareDialog({ prototypeId, versions, currentVersion, onClose }: {
  prototypeId: string;
  versions: { version: number }[];
  currentVersion?: number;
  onClose: () => void;
}) {
  const latest = versions.reduce((value, item) => Math.max(value, item.version), 0);
  const [version, setVersion] = useState(currentVersion && versions.some((item) => item.version === currentVersion) ? currentVersion : latest);
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

  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-eui-graphite/70 p-4" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="share-dialog-title" className="my-auto w-full max-w-2xl rounded-3xl bg-white p-6 text-eui-ink shadow-2xl">
      <div className="flex items-center justify-between gap-4">
        <h2 id="share-dialog-title" className="font-eui-display text-2xl font-bold">{shareStrings.dialogTitle}</h2>
        <button type="button" aria-label={shareStrings.close} title={shareStrings.close} onClick={onClose} className="rounded-full px-2 py-1 text-xl hover:bg-eui-lilac-100">×</button>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">{shareStrings.version}
          <select className={inputBase} value={version} onChange={(event) => setVersion(Number(event.target.value))}>
            {[...versions].sort((a, b) => b.version - a.version).map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">{shareStrings.ttl}
          <select className={inputBase} value={ttlSeconds} onChange={(event) => setTtlSeconds(Number(event.target.value))}>
            {shareTtlOptions.map((item) => <option key={item.seconds} value={item.seconds}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <button type="button" className={`${pillPrimary} mt-4`} disabled={submitting} onClick={() => { void create(); }}>{submitting ? shareStrings.creating : shareStrings.create}</button>
      {error ? <p role="alert" className="mt-3 text-sm text-eui-magenta">{error}</p> : null}

      {created ? <section aria-label={shareStrings.createdLabel} className="mt-6 rounded-2xl bg-eui-lilac-50 p-4">
        <h3 className="font-semibold">{shareStrings.createdLabel}</h3>
        <div className="mt-3 flex gap-2">
          <input className={`${inputBase} min-w-0 flex-1`} value={created.url} readOnly aria-label={shareStrings.createdLabel} />
          <button type="button" className={pillGhost} onClick={() => { void copy(); }}>{copied ? shareStrings.copied : shareStrings.copy}</button>
        </div>
        <div className="mt-4 flex justify-center rounded-2xl bg-white p-4">
          <QRCodeSVG value={created.url} size={180} marginSize={1} role="img" aria-label={shareStrings.qrLabel} />
        </div>
      </section> : null}

      <section className="mt-6" aria-labelledby="active-shares-title">
        <h3 id="active-shares-title" className="font-eui-display text-lg font-bold">{shareStrings.activeTitle}</h3>
        {loading ? <p className="mt-2 text-sm text-eui-slate-500">{shareStrings.loading}</p>
          : grants.length === 0 ? <p className="mt-2 text-sm text-eui-slate-500">{shareStrings.activeEmpty}</p>
            : <ul className="mt-3 grid gap-2">{grants.map((grant) => <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-eui-ink/10 px-4 py-3">
              <span><span className="block text-sm font-medium">{shareStrings.activeItem(grant.version, expires(grant.expiresAt))}</span><span className="text-xs text-eui-slate-500">{shareStrings.sessions(grant.activeSessions)}</span></span>
              <button type="button" className={pillGhost} onClick={() => { void revoke(grant.id); }}>{shareStrings.revoke}</button>
            </li>)}</ul>}
      </section>
    </section>
  </div>;
}
