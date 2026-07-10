import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve("dist");
const manifest = JSON.parse(await readFile(resolve(dist, ".vite/manifest.json"), "utf8"));
const appEntry = Object.values(manifest).find((chunk) => chunk.isEntry);

if (!appEntry?.css?.length) {
  throw new Error("Vite manifest has no CSS for the app entry chunk");
}

const css = (await Promise.all(appEntry.css.map((file) => readFile(resolve(dist, file), "utf8")))).join("\n");
const sentinels = [".inline-flex", ".bg-primary", ".rounded-md"];
const missing = sentinels.filter((selector) => !css.includes(selector));

if (missing.length) {
  throw new Error(`Missing shadcn Button CSS sentinels: ${missing.join(", ")}`);
}

console.log(`CSS check passed: ${appEntry.css.join(", ")}`);
