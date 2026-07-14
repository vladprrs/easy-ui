/* global performance, process, requestAnimationFrame, URL */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { cleanupPerfGalleryDataset, createPerfGalleryDataset } from "./perf-gallery-dataset";

const VIEWPORT = { width: 1440, height: 900 };
const NETWORK = { latencyMs: 40, downloadBytesPerSecond: 5 * 1024 * 1024 / 8, uploadBytesPerSecond: 1 * 1024 * 1024 / 8 };

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function configureNetwork(context, page, cacheDisabled) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled });
  await session.send("Network.emulateNetworkConditions", {
    offline: false, latency: NETWORK.latencyMs,
    downloadThroughput: NETWORK.downloadBytesPerSecond,
    uploadThroughput: NETWORK.uploadBytesPerSecond,
    connectionType: "wifi",
  });
}

async function sample(page, baseUrl, previews) {
  const url = new URL(baseUrl);
  if (!previews) url.searchParams.set("galleryPreviews", "off");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-gallery-ready="true"]');
  const search = page.getByLabel("Поиск по названию");
  await search.fill("Перф-прототип 00");
  await page.getByRole("heading", { name: /^Перф-прототип 00/ }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return await page.evaluate(() => performance.now());
}

async function coldSamples(browser, baseUrl, previews, runs) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await configureNetwork(context, page, true);
    samples.push(await sample(page, baseUrl, previews));
    await context.close();
  }
  return samples;
}

async function warmSamples(browser, baseUrl, previews, runs) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await configureNetwork(context, page, false);
  await sample(page, baseUrl, previews);
  const samples = [];
  for (let run = 0; run < runs; run += 1) samples.push(await sample(page, baseUrl, previews));
  await context.close();
  return samples;
}

function degradation(baseline, preview) {
  return (preview - baseline) / baseline * 100;
}

const baseUrl = argument("--url", process.env.PERF_GALLERY_URL ?? "http://127.0.0.1:4173/");
const runs = Number(argument("--runs", "5"));
const reportPath = argument("--report", "docs/perf-gallery-report.md");
if (!Number.isInteger(runs) || runs < 5) throw new Error("--runs must be an integer >= 5");
const root = new URL(baseUrl);
const authorization = process.env.PERF_GALLERY_AUTH;
const datasetOptions = { apiBase: new URL("/api", root).href.replace(/\/$/, ""), authorization };
const browser = await chromium.launch({ headless: true });

try {
  const dataset = await createPerfGalleryDataset(datasetOptions);
  // Keep variants isolated: concurrent page loads would make the shared API/server
  // the benchmark bottleneck and invalidate the baseline comparison.
  const coldBaseline = await coldSamples(browser, baseUrl, false, runs);
  const coldPreview = await coldSamples(browser, baseUrl, true, runs);
  const warmBaseline = await warmSamples(browser, baseUrl, false, runs);
  const warmPreview = await warmSamples(browser, baseUrl, true, runs);
  const cold = { baseline: median(coldBaseline), preview: median(coldPreview) };
  const warm = { baseline: median(warmBaseline), preview: median(warmPreview) };
  const coldDelta = degradation(cold.baseline, cold.preview);
  const warmDelta = degradation(warm.baseline, warm.preview);
  const passed = coldDelta < 20 && warmDelta < 20;
  const report = `# W5-3 gallery preview performance gate\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `Command: \`npx tsx scripts/perf-gallery.mjs --url ${baseUrl} --runs ${runs}\`\n\n` +
    `Dataset: ${dataset.created} API-created prototypes (${dataset.custom} custom DS); cleanup runs in \`finally\`. Seed sources are untouched.\n\n` +
    `Viewport: ${VIEWPORT.width}×${VIEWPORT.height}. Network: ${NETWORK.latencyMs} ms RTT, ${(NETWORK.downloadBytesPerSecond * 8 / 1024 / 1024).toFixed(0)} Mbit/s down, ${(NETWORK.uploadBytesPerSecond * 8 / 1024 / 1024).toFixed(0)} Mbit/s up. TTI is navigation start → gallery controls accept a search and the filtered card is painted for two animation frames.\n\n` +
    `| Run mode | Baseline median, ms | Preview median, ms | Degradation | Gate |\n|---|---:|---:|---:|---|\n` +
    `| Cold (${runs} runs) | ${cold.baseline.toFixed(1)} | ${cold.preview.toFixed(1)} | ${coldDelta.toFixed(2)}% | ${coldDelta < 20 ? "PASS" : "FAIL"} |\n` +
    `| Warm (${runs} runs) | ${warm.baseline.toFixed(1)} | ${warm.preview.toFixed(1)} | ${warmDelta.toFixed(2)}% | ${warmDelta < 20 ? "PASS" : "FAIL"} |\n\n` +
    `Overall: **${passed ? "PASS" : "FAIL"}** (both medians must degrade by <20%).\n\n` +
    `<details><summary>Raw samples (ms)</summary>\n\n\`\`\`json\n${JSON.stringify({ coldBaseline, coldPreview, warmBaseline, warmPreview }, null, 2)}\n\`\`\`\n</details>\n`;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report);
  console.log(report);
  if (!passed) process.exitCode = 2;
} finally {
  await browser.close();
  const cleaned = await cleanupPerfGalleryDataset(datasetOptions);
  console.log(`Cleaned ${cleaned} performance prototypes.`);
}
