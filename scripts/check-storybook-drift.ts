import { readFile } from "node:fs/promises";
import { expectedStoryIds } from "../src/catalog/fixtures";

function indexPath(argv: string[]) {
  const position = argv.indexOf("--index");
  if (position === -1) return "dist/storybook/index.json";
  if (!argv[position + 1]) throw new Error("--index requires a path");
  return argv[position + 1];
}

try {
  const path = indexPath(process.argv.slice(2));
  const index = JSON.parse(await readFile(path, "utf8")) as { entries?: Record<string, unknown> };
  const actualIds = new Set(Object.keys(index.entries ?? {}));
  const missing = expectedStoryIds.filter((id) => !actualIds.has(id));
  if (missing.length) {
    console.error(`Storybook drift: missing expected stories:\n${missing.map((id) => `- ${id}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Storybook drift check passed (${expectedStoryIds.length} expected stories).`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
