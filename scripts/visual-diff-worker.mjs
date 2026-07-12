// Visual-diff worker: one comparison per process, JSON over stdin -> single JSON
// line on stdout. Runs under node with pngjs (decode/encode) + pixelmatch. Never
// invents a percentage: mismatched dimensions are reported as such with no diff
// pixels, and both honest metrics (exact-rgba + pixelmatch-v1) are returned from
// the same buffers so the caller can build a full evidence report.
/* global process, Buffer */
import pixelmatch from "pixelmatch";
import pngjs from "pngjs";

const { PNG } = pngjs;

/** Count pixels whose RGBA bytes differ exactly (no tolerance). Requires equal length. */
export function exactRgbaDiff(a, b) {
  let diff = 0;
  const total = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) diff += 1;
  }
  return { diffPixels: diff, totalPixels: total };
}

export function compare(referencePng, candidatePng, options) {
  const ref = PNG.sync.read(referencePng);
  const cand = PNG.sync.read(candidatePng);
  const refDims = { width: ref.width, height: ref.height };
  const candDims = { width: cand.width, height: cand.height };
  if (ref.width !== cand.width || ref.height !== cand.height) {
    return { ok: true, dimensionMismatch: true, refDims, candDims };
  }
  const threshold = typeof options?.threshold === "number" ? options.threshold : 0.1;
  const includeAA = options?.includeAA === true;
  const out = new PNG({ width: ref.width, height: ref.height });
  const total = ref.width * ref.height;
  const pmDiff = pixelmatch(ref.data, cand.data, out.data, ref.width, ref.height, { threshold, includeAA });
  const exact = exactRgbaDiff(ref.data, cand.data);
  return {
    ok: true,
    dimensionMismatch: false,
    refDims,
    candDims,
    exact: { diffPixels: exact.diffPixels, totalPixels: exact.totalPixels },
    pixelmatch: { diffPixels: pmDiff, totalPixels: total, options: { threshold, includeAA } },
    diffPngBase64: PNG.sync.write(out).toString("base64"),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  readStdin()
    .then((job) => compare(Buffer.from(job.referencePngBase64, "base64"), Buffer.from(job.candidatePngBase64, "base64"), job.options))
    .then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); process.exit(0); })
    .catch((error) => { process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? String(error) }) + "\n"); process.exit(1); });
}
