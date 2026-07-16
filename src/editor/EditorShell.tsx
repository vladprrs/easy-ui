import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ApiError, listPrototypeRevisions } from "../api/client";
import { useApi } from "../api/hooks";
import { gallery } from "../app/strings/gallery";
import { LoadError, MissingPrototype, PrototypeLoader } from "../player/PrototypeLoader";
import { EditorView } from "./EditorView";

export function EditorShell() {
  const { protoId } = useParams();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const access = useApi((signal) => protoId
    ? listPrototypeRevisions(protoId, { limit: 1, signal })
    : Promise.reject(new ApiError(404, { code: "prototype_not_found", message: "Prototype not found" })), [protoId]);
  const forbidden = access.status === "error" && access.error instanceof ApiError && (access.error.status === 403 || access.error.status === 404);
  useEffect(() => {
    if (forbidden) void navigate("/", { replace: true, state: { notice: gallery.editorForbiddenNotice } });
  }, [forbidden, navigate]);
  if (!protoId) return <MissingPrototype />;
  if (access.status === "loading" || forbidden) return <p className="mx-auto max-w-xl rounded-2xl bg-eui-lilac-100 p-6 text-center font-eui-ui text-eui-slate-500" role="status">Проверяем доступ к редактору…</p>;
  if (access.status === "error") return <LoadError error={access.error} retry={access.reload} />;
  return <PrototypeLoader key={reloadKey} protoId={protoId}>
    {({ loaded, custom, runtimeKey }) => <EditorView loaded={loaded} custom={custom} runtimeKey={runtimeKey} onReload={() => setReloadKey((key) => key + 1)} />}
  </PrototypeLoader>;
}
