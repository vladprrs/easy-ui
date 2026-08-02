#!/usr/bin/env node
/* global process, console */
// Pixel diff between a Figma reference export and an easy-ui snap (план agent-iteration DX, P3).
// Печатает не только «% mismatch», но и диагностику, по которой видно, ЧТО править:
// bounding-box'ы кластеров расхождений, второй прогон с порогом AA-диагностики и
// покадровые бюджеты по регионам. Оба входных PNG читаются только на чтение — raw-эталон
// не мутируется никогда (единственный записываемый файл — необязательный diff.png).
//
// usage: compare.mjs <reference.png> <candidate.png> [diff.png]
//          [--threshold 0.1] [--region x,y,w,h[:maxDiff%]]... [--clusters N] [--json]
//
// exit codes:
//   0 — дифф посчитан, бюджеты регионов (если заданы) соблюдены
//   1 — бюджет какого-то --region превышен
//   2 — bad usage / missing deps
//   3 — размеры PNG не совпали (отчёт всё равно печатается: дифф считается по пересечению)
//
// one-time setup in this directory: npm i pixelmatch pngjs

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

let pixelmatch, PNG;
try {
  ({ default: pixelmatch } = await import("pixelmatch"));
  ({ PNG } = await import("pngjs"));
} catch {
  console.error("missing deps — run `npm i pixelmatch pngjs` in the skill directory");
  process.exit(2);
}

const USAGE = "usage: compare.mjs <reference.png> <candidate.png> [diff.png] [--threshold 0.1] [--region x,y,w,h[:maxDiff%]]... [--clusters N] [--json]";

/** Порог второго, диагностического прогона: расхождения выше него — уже не сглаживание. */
export const AA_DIAGNOSTIC_THRESHOLD = 0.25;
/** Сколько кластеров печатать по умолчанию (сортировка — по числу расходящихся пикселей). */
export const DEFAULT_CLUSTER_LIMIT = 10;

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

/** `x,y,w,h` либо `x,y,w,h:maxDiff%` — бюджет опционален и задаётся в процентах. */
export function parseRegion(value) {
  const [box, budget] = String(value).split(":");
  const parts = box.split(",").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`--region must be x,y,w,h[:maxDiff%] with non-negative integers, got ${value}`);
  }
  const [x, y, width, height] = parts;
  if (width === 0 || height === 0) throw new Error(`--region must have non-zero width and height, got ${value}`);
  let maxDiffPercent;
  if (budget !== undefined) {
    maxDiffPercent = Number(String(budget).replace(/%$/, ""));
    if (!Number.isFinite(maxDiffPercent) || maxDiffPercent < 0 || maxDiffPercent > 100) {
      throw new Error(`--region budget must be a percentage from 0 to 100, got ${value}`);
    }
  }
  return { x, y, width, height, maxDiffPercent, label: value };
}

export function parseCompareArgs(argv) {
  const positionals = [];
  const regions = [];
  let threshold = 0.1;
  let clusterLimit = DEFAULT_CLUSTER_LIMIT;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--json") { json = true; continue; }
    if (token === "--threshold" || token === "--region" || token === "--clusters") {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${token} requires a value`);
      if (token === "--threshold") {
        threshold = Number(value);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("--threshold must be a number from 0 to 1");
      } else if (token === "--clusters") {
        clusterLimit = Number(value);
        if (!Number.isInteger(clusterLimit) || clusterLimit < 1) throw new Error("--clusters must be a positive integer");
      } else regions.push(parseRegion(value));
      continue;
    }
    if (token.startsWith("--")) throw new Error(`unknown flag: ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2 || positionals.length > 3) throw new Error(USAGE);
  const [referencePath, candidatePath, diffPath] = positionals;
  return { referencePath, candidatePath, diffPath, threshold, regions, clusterLimit, json };
}

/**
 * Кластеры расхождений: связные области (8-связность) по маске диффа, свёрнутые в
 * bounding-box'ы. Именно они превращают «0,4% пикселей» в «сдвинут бейдж 12x3 px @ (208,41)».
 * Итеративный flood fill — рекурсия переполнила бы стек на сплошной полосе.
 */
export function clusterMask(mask, width, height) {
  const seen = new Uint8Array(width * height);
  const clusters = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let minX = width, minY = height, maxX = -1, maxY = -1, pixels = 0;
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = (index - x) / width;
      pixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (!mask[neighbour] || seen[neighbour]) continue;
          seen[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    clusters.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels });
  }
  clusters.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
  return clusters;
}

/** Доля расходящихся пикселей внутри прямоугольника; регион клампится к площади сравнения. */
export function regionStats(mask, width, height, region) {
  const x0 = Math.min(region.x, width);
  const y0 = Math.min(region.y, height);
  const x1 = Math.min(region.x + region.width, width);
  const y1 = Math.min(region.y + region.height, height);
  const clipped = x1 - x0 !== region.width || y1 - y0 !== region.height;
  let mismatched = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (mask[y * width + x]) mismatched += 1;
  }
  const total = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const percent = total === 0 ? 0 : (mismatched / total) * 100;
  const withinBudget = region.maxDiffPercent === undefined ? null : percent <= region.maxDiffPercent;
  return { ...region, mismatched, total, percent, clipped, withinBudget };
}

/** Копия строки-в-строку в пересечение размеров: сравнивать можно только общую площадь. */
function cropRgba(image, width, height) {
  if (image.width === width && image.height === height) return image.data;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    image.data.copy(data, y * width * 4, y * image.width * 4, y * image.width * 4 + width * 4);
  }
  return data;
}

/** Маска расхождений: pixelmatch в режиме diffMask метит только сами пиксели (alpha > 0). */
function diffMask(referenceData, candidateData, width, height, threshold) {
  const output = Buffer.alloc(width * height * 4);
  const mismatched = pixelmatch(referenceData, candidateData, output, width, height, { threshold, diffMask: true });
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) mask[index] = output[index * 4 + 3] > 0 ? 1 : 0;
  return { mismatched, mask };
}

export function compareImages(reference, candidate, { threshold, regions = [], clusterLimit = DEFAULT_CLUSTER_LIMIT, diff = false }) {
  const width = Math.min(reference.width, candidate.width);
  const height = Math.min(reference.height, candidate.height);
  const sizeMismatch = reference.width !== candidate.width || reference.height !== candidate.height;
  const referenceData = cropRgba(reference, width, height);
  const candidateData = cropRgba(candidate, width, height);

  const primary = diffMask(referenceData, candidateData, width, height, threshold);
  const aaDiagnostic = diffMask(referenceData, candidateData, width, height, AA_DIAGNOSTIC_THRESHOLD);
  const total = width * height;

  let diffPng = null;
  if (diff) {
    diffPng = new PNG({ width, height });
    pixelmatch(referenceData, candidateData, diffPng.data, width, height, { threshold });
  }

  return {
    reference: { width: reference.width, height: reference.height },
    candidate: { width: candidate.width, height: candidate.height },
    comparedArea: { width, height },
    sizeMismatch,
    threshold,
    total,
    mismatched: primary.mismatched,
    percent: total === 0 ? 0 : (primary.mismatched / total) * 100,
    aaDiagnostic: {
      threshold: AA_DIAGNOSTIC_THRESHOLD,
      mismatched: aaDiagnostic.mismatched,
      percent: total === 0 ? 0 : (aaDiagnostic.mismatched / total) * 100,
    },
    clusters: clusterMask(primary.mask, width, height),
    clusterLimit,
    regions: regions.map((region) => regionStats(primary.mask, width, height, region)),
    diffPng,
  };
}

const pct = (value) => `${value.toFixed(2)}%`;

export function reportLines(result, diffPath) {
  const lines = [];
  if (result.sizeMismatch) {
    lines.push(
      `size mismatch: candidate ${result.candidate.width}x${result.candidate.height} vs ref ${result.reference.width}x${result.reference.height}` +
      ` (dw ${result.candidate.width - result.reference.width}, dh ${result.candidate.height - result.reference.height})`,
      `comparing the overlapping ${result.comparedArea.width}x${result.comparedArea.height} area; make the probe canvas equal to the Figma frame (and the export scale equal to the snap dsf)`,
    );
  }
  lines.push(`${result.mismatched}/${result.total} px differ = ${pct(result.percent)} (threshold ${result.threshold})${diffPath ? ` -> ${diffPath}` : ""}`);
  lines.push(`AA-diagnostic (threshold ${result.aaDiagnostic.threshold}): ${result.aaDiagnostic.mismatched}/${result.total} px = ${pct(result.aaDiagnostic.percent)} — what remains after anti-aliasing tolerance`);
  const shown = result.clusters.slice(0, result.clusterLimit);
  lines.push(`clusters: ${result.clusters.length}${result.clusters.length > shown.length ? ` (showing ${shown.length})` : ""}`);
  for (const cluster of shown) lines.push(`  cluster ${cluster.width}x${cluster.height} px @ (${cluster.x},${cluster.y}) — ${cluster.pixels} px differ`);
  for (const region of result.regions) {
    const budget = region.maxDiffPercent === undefined ? "" : ` (budget ${region.maxDiffPercent}% — ${region.withinBudget ? "ok" : "EXCEEDED"})`;
    lines.push(`region ${region.label}: ${region.mismatched}/${region.total} px = ${pct(region.percent)}${budget}${region.clipped ? " [clipped to the compared area]" : ""}`);
  }
  return lines;
}

export function exitCodeOf(result) {
  if (result.regions.some((region) => region.withinBudget === false)) return 1;
  return result.sizeMismatch ? 3 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseCompareArgs(process.argv.slice(2)); }
  catch (error) { fail(error.message === USAGE ? USAGE : `${error.message}\n${USAGE}`); }

  let reference, candidate;
  try {
    reference = PNG.sync.read(readFileSync(options.referencePath));
    candidate = PNG.sync.read(readFileSync(options.candidatePath));
  } catch (error) {
    fail(`cannot read PNG: ${error.message}`);
  }

  const result = compareImages(reference, candidate, { ...options, diff: Boolean(options.diffPath) });
  if (options.diffPath) writeFileSync(options.diffPath, PNG.sync.write(result.diffPng));
  if (options.json) {
    const { diffPng, ...payload } = result;
    void diffPng;
    process.stdout.write(`${JSON.stringify({ ...payload, diffPath: options.diffPath ?? null, exitCode: exitCodeOf(result) }, null, 2)}\n`);
  } else {
    for (const line of reportLines(result, options.diffPath)) console.log(line);
  }
  process.exit(exitCodeOf(result));
}
