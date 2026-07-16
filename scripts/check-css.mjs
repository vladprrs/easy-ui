import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import postcss from "postcss";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compatPath = resolve("src/styles/shadcn-v1-compat.css");
const manifestPath = resolve("src/styles/shadcn-v1-compat.manifest.json");
const compatCss = await readFile(compatPath, "utf8");
const contract = JSON.parse(await readFile(manifestPath, "utf8"));

function orderedRules(css) {
  const entries = [];
  const visit = (container, context = []) => {
    for (const node of container.nodes ?? []) {
      if (node.type === "atrule") {
        entries.push({ kind: "at-rule", context, name: node.name, params: node.params, declarations: (node.nodes ?? []).filter((child) => child.type === "decl").map((decl) => ({ prop: decl.prop, value: decl.value, important: decl.important })) });
        visit(node, [...context, `@${node.name}${node.params ? ` ${node.params}` : ""}`]);
      } else if (node.type === "rule") {
        entries.push({ kind: "rule", context, selector: node.selector, declarations: (node.nodes ?? []).filter((child) => child.type === "decl").map((decl) => ({ prop: decl.prop, value: decl.value, important: decl.important })) });
        visit(node, [...context, node.selector]);
      }
    }
  };
  visit(postcss.parse(css));
  return entries;
}

if (contract.version !== 1 || contract.contract !== "shadcn-v1-tailwind-compat") throw new Error("Unknown CSS compatibility manifest");
if (sha256(compatCss) !== contract.cssSha256) throw new Error("Committed compat CSS hash differs from its manifest");
const committedRules = orderedRules(compatCss);
if (JSON.stringify(committedRules) !== JSON.stringify(contract.orderedRules)) throw new Error("Compat manifest no longer preserves the committed CSS rule order/cascade");

const manifest = JSON.parse(await readFile(resolve("dist/.vite/manifest.json"), "utf8"));
const appEntry = Object.values(manifest).find((chunk) => chunk.isEntry);
if (!appEntry?.css?.length) throw new Error("Vite manifest has no CSS for the app entry chunk");
const builtCompatPath = resolve("dist/assets/shadcn-v1-compat.css");
const builtCompatCss = await readFile(builtCompatPath, "utf8");
if (sha256(builtCompatCss) !== contract.cssSha256) throw new Error("Built compat CSS hash differs from the pre-removal contract");
if (JSON.stringify(orderedRules(builtCompatCss)) !== JSON.stringify(contract.orderedRules)) throw new Error("Built compat CSS changed rule/layer/media order");
const html = await readFile(resolve("dist/index.html"), "utf8");
const appCssPosition = Math.max(...appEntry.css.map((file) => html.indexOf(`/${file}`)));
const compatPosition = html.indexOf("/assets/shadcn-v1-compat.css");
if (appCssPosition < 0 || compatPosition < 0 || compatPosition < appCssPosition) throw new Error("Compat CSS must be linked globally after app CSS to preserve its cascade");

try {
  const storybook = await stat(resolve("dist/storybook"));
  if (storybook.isDirectory()) throw new Error("dist/storybook must not exist");
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

console.log(`CSS release gate passed: ${committedRules.length} ordered entries, sha256 ${contract.cssSha256}; compat CSS remains globally bundled as assets/shadcn-v1-compat.css`);
