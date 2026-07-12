import { canonicalStringify } from "./canonicalJson";

/** Browser-side propsHash (SHA-256 hex of the canonical JSON of the props). */
export async function propsHashBrowser(props: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalStringify(props ?? {}));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
