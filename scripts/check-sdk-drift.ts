// Drift check for the committed authoring-SDK catalog types: fails when
// sdk/catalog.sdk-demo.d.ts does not match what the generator produces from the committed
// snapshot fixture (sdk/fixtures/catalog.sdk-demo.json). Runs offline — no server required.
// Wired into `npm run verify:sdk`.

import { readFileSync } from "node:fs";
import { catalogDtsPath, readSnapshot, renderCatalogDts, SNAPSHOT_DESIGN_SYSTEM, snapshotPath } from "./generate-sdk";

const dtsPath = catalogDtsPath(SNAPSHOT_DESIGN_SYSTEM);

let committed = "";
try {
  committed = readFileSync(dtsPath, "utf8");
} catch {
  console.error(`${dtsPath} is missing. Run: npm run generate:sdk -- --design-system ${SNAPSHOT_DESIGN_SYSTEM} --from sdk/fixtures/catalog.${SNAPSHOT_DESIGN_SYSTEM}.json`);
  process.exit(1);
}

const expected = renderCatalogDts(readSnapshot(snapshotPath(SNAPSHOT_DESIGN_SYSTEM)), SNAPSHOT_DESIGN_SYSTEM);
if (committed !== expected) {
  console.error(`${dtsPath} is out of date with the catalog snapshot. Run: npm run generate:sdk -- --design-system ${SNAPSHOT_DESIGN_SYSTEM} --from sdk/fixtures/catalog.${SNAPSHOT_DESIGN_SYSTEM}.json`);
  process.exit(1);
}

console.log(`${dtsPath} is up to date`);
