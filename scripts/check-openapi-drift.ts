// Drift check for the committed OpenAPI document: fails when server/openapi.json
// does not match what the contract registry currently generates.
// Wired into `npm run verify` as `verify:openapi`.

import { readFileSync } from "node:fs";
import { OPENAPI_PATH, renderOpenApiJson } from "./generate-openapi";

let committed = "";
try {
  committed = readFileSync(OPENAPI_PATH, "utf8");
} catch {
  console.error(`server/openapi.json is missing. Run: npm run generate:openapi`);
  process.exit(1);
}

if (committed !== renderOpenApiJson()) {
  console.error("server/openapi.json is out of date with server/contracts.ts. Run: npm run generate:openapi");
  process.exit(1);
}

console.log("server/openapi.json is up to date");
