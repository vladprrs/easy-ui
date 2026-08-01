#!/usr/bin/env node
/* global process, console */
// Pixel diff between a Figma reference export and an easy-ui snap.
// usage: compare.mjs <reference.png> <candidate.png> [diff.png] [--threshold 0.1]
// exit codes: 0 diff computed (see printed %), 3 size mismatch, 2 bad usage / missing deps
//
// one-time setup in this directory: npm i pixelmatch pngjs

import { readFileSync, writeFileSync } from "node:fs";

let pixelmatch, PNG;
try {
  ({ default: pixelmatch } = await import("pixelmatch"));
  ({ PNG } = await import("pngjs"));
} catch {
  console.error("missing deps — run `npm i pixelmatch pngjs` in the skill directory");
  process.exit(2);
}

const args = process.argv.slice(2);
const thresholdIndex = args.indexOf("--threshold");
const threshold = thresholdIndex >= 0 ? Number(args.splice(thresholdIndex, 2)[1]) : 0.1;
const [referencePath, candidatePath, diffPath] = args;
if (!referencePath || !candidatePath) {
  console.error("usage: compare.mjs <reference.png> <candidate.png> [diff.png] [--threshold 0.1]");
  process.exit(2);
}

const reference = PNG.sync.read(readFileSync(referencePath));
const candidate = PNG.sync.read(readFileSync(candidatePath));
if (reference.width !== candidate.width || reference.height !== candidate.height) {
  console.error(
    `size mismatch: reference ${reference.width}x${reference.height} vs candidate ${candidate.width}x${candidate.height}\n` +
    "make the probe screen canvas equal to the Figma frame size (and match export scale to snap dsf)",
  );
  process.exit(3);
}

const diff = new PNG({ width: reference.width, height: reference.height });
const mismatched = pixelmatch(reference.data, candidate.data, diff.data, reference.width, reference.height, { threshold });
if (diffPath) writeFileSync(diffPath, PNG.sync.write(diff));

const total = reference.width * reference.height;
const pct = (mismatched / total) * 100;
console.log(`${mismatched}/${total} px differ = ${pct.toFixed(2)}% (threshold ${threshold})${diffPath ? ` -> ${diffPath}` : ""}`);
