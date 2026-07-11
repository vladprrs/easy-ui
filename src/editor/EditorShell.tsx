import { useState } from "react";
import { useParams } from "react-router";
import { PrototypeLoader } from "../player/PrototypeLoader";
import { EditorView } from "./EditorView";

export function EditorShell() {
  const { protoId } = useParams();
  const [reloadKey, setReloadKey] = useState(0);
  return <PrototypeLoader key={reloadKey} protoId={protoId}>
    {({ loaded, custom, runtimeKey }) => <EditorView loaded={loaded} custom={custom} runtimeKey={runtimeKey} onReload={() => setReloadKey((key) => key + 1)} />}
  </PrototypeLoader>;
}
