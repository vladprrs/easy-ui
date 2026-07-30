import { useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, listPrototypeRevisions } from "../api/client";
import { useApi } from "../api/hooks";
import { pillGhost, pillPrimary } from "../app/chrome";
import { EmptyState } from "../app/states";
import { common } from "../app/strings/common";
import { editor } from "../app/strings/editor";
import { gallery } from "../app/strings/gallery";
import { LoadError, MissingPrototype, PrototypeLoader } from "../player/PrototypeLoader";
import { EditorView } from "./EditorView";

export function EditorShell() {
  const { protoId } = useParams();
  const [reloadKey, setReloadKey] = useState(0);
  const access = useApi((signal) => protoId
    ? listPrototypeRevisions(protoId, { limit: 1, signal })
    : Promise.reject(new ApiError(404, { code: "prototype_not_found", message: "Prototype not found" })), [protoId]);
  const status = access.status === "error" && access.error instanceof ApiError ? access.error.status : null;
  if (!protoId) return <MissingPrototype />;
  if (status === 404) return <MissingPrototype />;
  // 403 — не «ещё грузим» и не сбой: прототип существует, но правка чужая. Раньше
  // это состояние выглядело как вечное «Проверяем доступ…» + молчаливый редирект
  // в галерею; теперь оно объясняет причину и даёт работающий вход — плеер.
  if (status === 403) return <EmptyState
    circles={false}
    title={editor.forbiddenTitle}
    description={gallery.editorForbiddenNotice}
    primary={<Link className={pillPrimary} to={`/p/${protoId}`}>{editor.forbiddenOpenPlayer}</Link>}
    secondary={<Link className={pillGhost} to="/">{common.backToGallery}</Link>}
  />;
  if (access.status === "loading") return <p className="mx-auto max-w-xl rounded-panel bg-white p-6 text-center text-eui-slate-500" role="status">{editor.accessChecking}</p>;
  if (access.status === "error") return <LoadError error={access.error} retry={access.reload} />;
  return <PrototypeLoader key={reloadKey} protoId={protoId}>
    {({ loaded, custom, runtimeKey }) => <EditorView loaded={loaded} custom={custom} runtimeKey={runtimeKey} onReload={() => setReloadKey((key) => key + 1)} />}
  </PrototypeLoader>;
}
