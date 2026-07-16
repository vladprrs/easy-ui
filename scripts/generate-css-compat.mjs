/* global process */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postcss from "postcss";

const [beforePath, withoutPackagePath] = process.argv.slice(2);
if (!beforePath || !withoutPackagePath) {
  throw new Error("Usage: node scripts/generate-css-compat.mjs <before.css> <without-package-source.css>");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const before = await readFile(resolve(beforePath), "utf8");
const withoutPackage = await readFile(resolve(withoutPackagePath), "utf8");
const beforeRoot = postcss.parse(before);
const withoutRoot = postcss.parse(withoutPackage);
const beforeUtilities = beforeRoot.nodes.find((node) => node.type === "atrule" && node.name === "layer" && node.params === "utilities");

if (!beforeUtilities) throw new Error("The pre-removal CSS has no @layer utilities");

// Keep the complete ordered utility layer, not just the package-only selector
// difference. Utilities from the app and package are interleaved by Tailwind;
// retaining the whole layer is what preserves their effective cascade order.
const compatRoot = postcss.root();
compatRoot.append(postcss.comment({ text: "Generated shadcn v1 CSS compatibility contract. Do not edit by hand." }));
compatRoot.append(beforeUtilities.clone());

const withoutTopLevel = new Set(withoutRoot.nodes.map((node) => node.toString()));
for (const node of beforeRoot.nodes) {
  if (node === beforeUtilities || node.type === "comment") continue;
  if (!withoutTopLevel.has(node.toString()) && (node.type === "atrule" && (node.name === "property" || node.name === "keyframes"))) {
    compatRoot.append(node.clone());
  }
}

const css = compatRoot.toString();
const orderedRules = [];
function visit(container, context = []) {
  for (const node of container.nodes ?? []) {
    if (node.type === "atrule") {
      const next = [...context, `@${node.name}${node.params ? ` ${node.params}` : ""}`];
      orderedRules.push({
        kind: "at-rule",
        context,
        name: node.name,
        params: node.params,
        declarations: (node.nodes ?? []).filter((child) => child.type === "decl").map((decl) => ({ prop: decl.prop, value: decl.value, important: decl.important })),
      });
      visit(node, next);
    } else if (node.type === "rule") {
      orderedRules.push({
        kind: "rule",
        context,
        selector: node.selector,
        declarations: (node.nodes ?? []).filter((child) => child.type === "decl").map((decl) => ({ prop: decl.prop, value: decl.value, important: decl.important })),
      });
      visit(node, [...context, node.selector]);
    }
  }
}
visit(compatRoot);

const manifest = {
  version: 1,
  contract: "shadcn-v1-tailwind-compat",
  source: {
    withPackageScanSha256: sha256(before),
    withoutPackageScanSha256: sha256(withoutPackage),
  },
  cssSha256: sha256(css),
  orderedRules,
};

await writeFile(resolve("src/styles/shadcn-v1-compat.css"), css);
await writeFile(resolve("src/styles/shadcn-v1-compat.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${orderedRules.length} ordered entries (${css.length} bytes, sha256 ${manifest.cssSha256})`);
