import { useParams } from "react-router";
import { PrototypeLoader } from "../player/PrototypeLoader";
import { CjmView } from "./CjmView";

export function CjmShell() {
  const { protoId, version } = useParams();
  const numericVersion = version === undefined ? undefined : Number(version);
  return <PrototypeLoader protoId={protoId} version={numericVersion}>
    {({ loaded, custom, runtimeKey, routeBase }) => <CjmView doc={loaded.doc} custom={custom} runtimeKey={runtimeKey} routeBase={routeBase} editable={version === undefined} />}
  </PrototypeLoader>;
}
