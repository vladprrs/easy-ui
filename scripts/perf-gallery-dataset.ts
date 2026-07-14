import { readFile } from "node:fs/promises";

export const PERF_GALLERY_PREFIX = "perf-gallery-";
const CUSTOM_DS_ID = "perf-gallery-custom-ds";
const CUSTOM_COMPONENT_ID = "perf-gallery-card";
const CUSTOM_COMPONENT_NAME = "PerfGalleryCard";

type PrototypeSummary = { id: string; headRev: number };

export type PerfGalleryDatasetOptions = {
  apiBase: string;
  authorization?: string;
};

function headers(options: PerfGalleryDatasetOptions, json = false): HeadersInit {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(options.authorization ? { authorization: options.authorization } : {}),
  };
}

async function api<T>(options: PerfGalleryDatasetOptions, path: string, init: RequestInit = {}, allowed = [200, 201, 204]): Promise<T> {
  const response = await fetch(`${options.apiBase.replace(/\/$/, "")}${path}`, { ...init, headers: { ...headers(options, init.body !== undefined), ...init.headers } });
  if (!allowed.includes(response.status)) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined as T : await response.json() as T;
}

function builtinDoc(index: number) {
  const device = (["mobile", "tablet", "desktop"] as const)[index % 3]!;
  const designSystem = index % 2 ? "wireframe" : "shadcn";
  const id = `${PERF_GALLERY_PREFIX}${String(index).padStart(2, "0")}`;
  const longTail = index % 10 === 0 ? ` — ${"ОченьДлинноеНазваниеБезПробелов".repeat(5)}` : "";
  return {
    version: 1, id, name: `Перф-прототип ${String(index).padStart(2, "0")}${longTail}`,
    description: `Изолированная W5-3 фикстура ${index}: inert-превью стартового экрана.`,
    designSystem, device, startScreen: "start", state: {},
    screens: [{
      id: "start", name: "Стартовый экран",
      spec: { root: "card", elements: {
        card: { type: "Card", props: { title: `Карточка ${index}` }, children: ["copy", "action"] },
        copy: { type: "Text", props: { text: `Содержимое превью ${index}` } },
        action: { type: "Button", props: { label: "Продолжить" }, on: { press: { action: "restart", params: {} } } },
      } },
    }],
  };
}

function customDoc(index: number) {
  const id = `${PERF_GALLERY_PREFIX}${String(index).padStart(2, "0")}`;
  return {
    version: 1, id, name: `Перф custom DS ${String(index).padStart(2, "0")}`,
    description: "Custom DS остаётся мета-карточкой: runtime bundle не загружается галереей.",
    designSystem: CUSTOM_DS_ID, device: "mobile", startScreen: "start", state: {},
    screens: [{ id: "start", name: "Custom start", spec: { root: "card", elements: { card: { type: CUSTOM_COMPONENT_NAME, props: { value: index % 6 } } } } }],
  };
}

async function ensureCustomDesignSystem(options: PerfGalleryDatasetOptions): Promise<void> {
  await api(options, "/design-systems", { method: "POST", body: JSON.stringify({ id: CUSTOM_DS_ID, name: "Perf Gallery Custom DS", description: "Reusable support fixture for the W5-3 API dataset." }) }, [201, 409]);
  const source = await readFile("server/fixtures/rating-stars.tsx", "utf8");
  await api(options, "/components", { method: "POST", body: JSON.stringify({ id: CUSTOM_COMPONENT_ID, name: CUSTOM_COMPONENT_NAME, source, designSystem: CUSTOM_DS_ID }) }, [201, 409]);
  await api(options, `/components/${CUSTOM_COMPONENT_ID}/publish`, { method: "POST", body: JSON.stringify({ baseRev: 1 }) }, [201, 409]);
}

export async function cleanupPerfGalleryDataset(options: PerfGalleryDatasetOptions): Promise<number> {
  const prototypes = await api<PrototypeSummary[]>(options, "/prototypes");
  const owned = prototypes.filter(({ id }) => id.startsWith(PERF_GALLERY_PREFIX));
  await Promise.all(owned.map(({ id, headRev }) => api(options, `/prototypes/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ baseRev: headRev }) })));
  return owned.length;
}

export async function createPerfGalleryDataset(options: PerfGalleryDatasetOptions): Promise<{ created: number; custom: number }> {
  await cleanupPerfGalleryDataset(options);
  await ensureCustomDesignSystem(options);
  const documents = Array.from({ length: 30 }, (_, index) => index >= 27 ? customDoc(index) : builtinDoc(index));
  for (const doc of documents) await api(options, "/prototypes", { method: "POST", body: JSON.stringify({ doc, message: "W5-3 gallery perf dataset" }) });
  return { created: documents.length, custom: documents.filter((doc) => doc.designSystem === CUSTOM_DS_ID).length };
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const action = process.argv[2];
  const apiBase = argument("--api", process.env.PERF_GALLERY_API ?? "http://127.0.0.1:4173/api")!;
  const options = { apiBase, authorization: process.env.PERF_GALLERY_AUTH };
  const result = action === "seed" ? await createPerfGalleryDataset(options)
    : action === "cleanup" ? { cleaned: await cleanupPerfGalleryDataset(options) }
      : null;
  if (!result) throw new Error("Usage: tsx scripts/perf-gallery-dataset.ts <seed|cleanup> [--api URL]");
  console.log(JSON.stringify(result));
}
