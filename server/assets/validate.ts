import { ApiError } from "../http";

// Maximum upload size (raw bytes) and maximum decoded pixel count for rasters (decompression-bomb guard).
export const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_ASSET_PIXELS = 16 * 1024 * 1024; // 16 Mpx

export type AssetKind = "png" | "jpeg" | "webp" | "gif" | "svg" | "woff2" | "ttf" | "otf";
export type ValidatedAsset = { kind: AssetKind; mime: string; width?: number; height?: number };

// Canonical mime per kind. Uploads declare a Content-Type that must match the real bytes.
const CANONICAL_MIME: Record<AssetKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

// Accepted mime aliases (normalized to a canonical kind). The declared Content-Type is looked up here.
const MIME_TO_KIND: Record<string, AssetKind> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "font/woff2": "woff2",
  "application/font-woff2": "woff2",
  "font/ttf": "ttf",
  "font/sfnt": "ttf",
  "application/font-sfnt": "ttf",
  "application/x-font-ttf": "ttf",
  "font/otf": "otf",
  "application/x-font-otf": "otf",
};

const RASTER = new Set<AssetKind>(["png", "jpeg", "webp", "gif"]);

export function normalizeMime(raw: string | null | undefined): string {
  return (raw ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

// Detects the real kind purely from leading bytes; returns null when nothing matches.
export function detectKind(bytes: Uint8Array): AssetKind | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "gif";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "wOF2") return "woff2";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OTTO") return "otf";
  if (bytes.length >= 4 && ((bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) || ascii(bytes, 0, 4) === "true" || ascii(bytes, 0, 4) === "ttcf")) return "ttf";
  if (looksLikeSvg(bytes)) return "svg";
  return null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  // Skip a UTF-8/UTF-16 BOM, then scan a bounded prefix for an <svg or <?xml/<!-- opener.
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 2048)); } catch { return false; }
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("<svg")) return true;
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<!--") || trimmed.startsWith("<!DOCTYPE")) return /<svg[\s>]/i.test(text);
  return false;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => (b[o]! * 0x1000000) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

// Decodes intrinsic pixel dimensions from raster headers. Returns null when the header is malformed.
export function decodeDimensions(kind: AssetKind, bytes: Uint8Array): { width: number; height: number } | null {
  try {
    if (kind === "png") {
      if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
    if (kind === "gif") {
      if (bytes.length < 10) return null;
      return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
    }
    if (kind === "jpeg") return decodeJpeg(bytes);
    if (kind === "webp") return decodeWebp(bytes);
  } catch { return null; }
  return null;
}

function decodeJpeg(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2; // skip SOI
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    let marker = bytes[offset + 1]!;
    while (marker === 0xff && offset + 1 < bytes.length) { offset += 1; marker = bytes[offset + 1]!; }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 >= bytes.length) return null;
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const segLength = u16be(bytes, offset + 2);
    if (segLength < 2) return null;
    offset += 2 + segLength;
  }
  return null;
}

function decodeWebp(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const format = ascii(bytes, 12, 4);
  if (format === "VP8 ") {
    // Lossy: 3-byte frame tag, 3-byte start code (0x9d 0x01 0x2a), then 14-bit width/height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (format === "VP8L") {
    // Lossless: signature 0x2f at offset 20, then 14-bit width/height packed across 4 bytes.
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21]!, b1 = bytes[22]!, b2 = bytes[23]!, b3 = bytes[24]!;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (format === "VP8X") {
    // Extended: 24-bit (canvas width-1, height-1) little-endian at offsets 24 and 27.
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  }
  return null;
}

// Validates a raw upload against its declared mime and the pixel/format limits.
// Throws ApiError (422 mismatch / 413 too many pixels) and returns the canonical metadata.
export function validateAsset(bytes: Uint8Array, declaredMime: string): ValidatedAsset {
  const normalized = normalizeMime(declaredMime);
  const declaredKind = MIME_TO_KIND[normalized];
  if (!declaredKind) throw new ApiError(422, "unsupported_asset_type", `Unsupported or missing asset Content-Type: ${normalized || "(none)"}`);
  const actualKind = detectKind(bytes);
  if (actualKind === null) throw new ApiError(422, "asset_type_mismatch", "Asset bytes do not match any supported format");
  if (actualKind !== declaredKind) throw new ApiError(422, "asset_type_mismatch", `Declared ${normalized} but bytes are ${CANONICAL_MIME[actualKind]}`);
  const asset: ValidatedAsset = { kind: actualKind, mime: CANONICAL_MIME[actualKind] };
  if (RASTER.has(actualKind)) {
    const dims = decodeDimensions(actualKind, bytes);
    if (!dims || dims.width <= 0 || dims.height <= 0) throw new ApiError(422, "asset_type_mismatch", "Could not decode raster image dimensions");
    if (dims.width * dims.height > MAX_ASSET_PIXELS) throw new ApiError(413, "asset_too_large", `Image exceeds ${MAX_ASSET_PIXELS} pixel limit (${dims.width}x${dims.height})`);
    asset.width = dims.width;
    asset.height = dims.height;
  }
  return asset;
}
