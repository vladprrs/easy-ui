import { useEffect, useRef, useState } from "react";
import { listPrototypeVersions, type PrototypeVersionSummary } from "../api/client";
import { pillGhost } from "../app/chrome";
import { common } from "../app/strings/common";
import { gallery } from "../app/strings/gallery";
import { ShareDialog } from "../player/ShareDialog";

type VersionsState =
  | { status: "loading" | "error"; versions: PrototypeVersionSummary[] }
  | { status: "ready"; versions: PrototypeVersionSummary[] };

export function GalleryShareDialog({ prototypeId, latestVersion, onClose }: {
  prototypeId: string;
  latestVersion: number;
  onClose: () => void;
}) {
  const [state, setState] = useState<VersionsState>({ status: "loading", versions: [] });
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void listPrototypeVersions(prototypeId, controller.signal).then(
      (versions) => { if (!controller.signal.aborted) setState({ status: "ready", versions }); },
      () => { if (!controller.signal.aborted) setState({ status: "error", versions: [] }); },
    );
    return () => controller.abort();
  }, [prototypeId]);

  const retry = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: "loading", versions: [] });
    void listPrototypeVersions(prototypeId, controller.signal).then(
      (versions) => { if (!controller.signal.aborted) setState({ status: "ready", versions }); },
      () => { if (!controller.signal.aborted) setState({ status: "error", versions: [] }); },
    );
  };

  const close = () => {
    controllerRef.current?.abort();
    onClose();
  };

  if (state.status === "ready" && state.versions.length > 0) {
    return <ShareDialog prototypeId={prototypeId} versions={state.versions} currentVersion={latestVersion} onClose={close} />;
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
    <section role="dialog" aria-modal="true" aria-labelledby="gallery-share-dialog-title" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
      <div className="flex items-center justify-between gap-4">
        <h2 id="gallery-share-dialog-title" className="font-eui-display text-2xl font-medium">{gallery.shareDialogTitle}</h2>
        <button type="button" aria-label={common.close} title={common.close} onClick={close} className="rounded-full px-2 py-1 text-xl hover:bg-eui-lilac-100">×</button>
      </div>
      {state.status === "loading" ? <p className="mt-5 text-sm text-eui-slate-500" aria-live="polite">{gallery.shareVersionsLoading}</p> : null}
      {state.status === "error" ? <div className="mt-5">
        <p role="alert" className="text-sm text-eui-magenta">{gallery.shareVersionsLoadFailed}</p>
        <button type="button" className={`${pillGhost} mt-3`} onClick={retry}>{common.retry}</button>
      </div> : null}
      {state.status === "ready" && state.versions.length === 0 ? <p className="mt-5 text-sm text-eui-slate-500">{gallery.shareVersionsEmpty}</p> : null}
    </section>
  </div>;
}
