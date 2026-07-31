import { useCallback, useEffect, useRef, useState } from "react";
import { listPrototypeVersions, type PrototypeVersionSummary } from "../api/client";
import { ShareDialog, type ShareVersionsState } from "../player/ShareDialog";

/**
 * Загрузчик списка версий для окна шаринга.
 *
 * Раньше он сам рисовал маленькую панель на время загрузки и подменял её широким
 * `ShareDialog`, когда версии приезжали, — диалог визуально прыгал. Теперь корпус
 * всегда один: сюда осталась только загрузка, а все её состояния рендерятся
 * внутри финальной панели (план W6 §2).
 */
export function GalleryShareDialog({ prototypeId, latestVersion, onClose }: {
  prototypeId: string;
  latestVersion: number;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ status: "loading" | "error" } | { status: "ready"; versions: PrototypeVersionSummary[] }>({ status: "loading" });
  // Счётчик попыток — единственный вход в загрузку: и монтирование, и «Повторить»
  // выражаются им, поэтому эффект не вызывает setState синхронно в теле.
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void listPrototypeVersions(prototypeId, controller.signal).then(
      (versions) => { if (!controller.signal.aborted) setState({ status: "ready", versions }); },
      () => { if (!controller.signal.aborted) setState({ status: "error" }); },
    );
    return () => controller.abort();
  }, [prototypeId, attempt]);

  const load = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  const close = () => {
    controllerRef.current?.abort();
    onClose();
  };

  const versions: ShareVersionsState = state.status === "ready"
    ? { status: "ready", versions: state.versions }
    : state.status === "error" ? { status: "error", onRetry: load } : { status: "loading" };

  return <ShareDialog prototypeId={prototypeId} versions={versions} currentVersion={latestVersion} onClose={close} />;
}
