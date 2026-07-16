import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { storedPrototypeDocSchema } from "../src/prototype/schema";
import { validatePrototype } from "../src/prototype/validate";

const directory = resolve("test/fixtures");
const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
let failed = false;

for (const file of files) {
  let input: unknown;
  try { input = JSON.parse(await readFile(resolve(directory, file), "utf8")); }
  catch (error) { console.error(`FAIL ${file}: ${String(error)}`); failed = true; continue; }
  const parsed = storedPrototypeDocSchema.safeParse(input);
  if (!parsed.success) {
    console.error(`FAIL ${file}`);
    parsed.error.issues.forEach((entry) => console.error(`  /${entry.path.join("/")}: ${entry.message}`));
    failed = true;
    continue;
  }
  const result = validatePrototype(parsed.data);
  const expectedId = basename(file, ".json");
  if (parsed.data.id !== expectedId) result.errors.push({ path: "/id", message: `must equal filename ${expectedId}` });
  if (result.errors.length) { console.error(`FAIL ${file}`); result.errors.forEach((entry) => console.error(`  ${entry.path}: ${entry.message}`)); failed = true; }
  else console.log(`OK   ${file}${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ""}`);
  result.warnings.forEach((entry) => console.warn(`  warning ${entry.path}: ${entry.message}`));
}

if (!files.length) { console.error("FAIL no prototype JSON files found"); failed = true; }
if (failed) process.exitCode = 1;
