import { immutable } from "../http";
import { ABI_V1, emitShim, type ShimName } from "../shims/abi-v1";
import { EASY_UI_RUNTIME_FILE, emitEasyUiRuntimeShim, isV2StandardShim } from "../shims/abi-v2";

const jsResponse = (body: string) => new Response(body, { headers: { ...immutable, "content-type": "text/javascript; charset=utf-8" } });
const notFound = () => new Response("Not found", { status: 404 });

export function routeShims(request: Request, segments: string[]): Response {
  if (request.method !== "GET") return new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "Method not allowed" } }), { status: 405, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const version = segments[1];
  const file = segments[2];
  if (!file?.endsWith(".js")) return notFound();
  if (version === "v2") {
    if (file === EASY_UI_RUNTIME_FILE) return jsResponse(emitEasyUiRuntimeShim());
    const name = file.slice(0, -3);
    if (isV2StandardShim(name)) return jsResponse(emitShim(name));
    return notFound();
  }
  if (version === "v1") {
    const name = file.slice(0, -3) as ShimName;
    if (!Object.hasOwn(ABI_V1, name)) return notFound();
    return jsResponse(emitShim(name));
  }
  return notFound();
}
