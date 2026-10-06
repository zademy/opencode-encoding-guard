import { stripBom } from "./codec.js";
import type { BomKind, SupportedEncoding } from "./types.js";

export function hasUtf8Bom(bytes: Buffer): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  );
}

export function detectBom(bytes: Buffer): BomKind {
  if (hasUtf8Bom(bytes)) return "utf8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return "utf16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return "utf16be";
  return null;
}

/**
 * NUL bytes (or a UTF-16 BOM) mean "not our business". Re-encoding those as
 * single-byte text would destroy them, so the guard refuses to touch them.
 */
export function isBinary(bytes: Buffer): boolean {
  if (detectBom(bytes) === "utf16le" || detectBom(bytes) === "utf16be")
    return true;
  const limit = Math.min(bytes.length, 8192);
  for (let index = 0; index < limit; index++) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

export function isAscii(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte > 0x7f) return false;
  }
  return true;
}

export function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(stripBom(bytes));
    return true;
  } catch {
    return false;
  }
}

export interface ByteEvidence {
  hasHighBytes: boolean;
  /** Bytes in 0x80–0x9F: valid in Windows-1252, undefined in ISO-8859-1. */
  hasCp1252Range: boolean;
  validUtf8: boolean;
}

export function analyzeBytes(bytes: Buffer): ByteEvidence {
  let hasHighBytes = false;
  let hasCp1252Range = false;
  for (const byte of stripBom(bytes)) {
    if (byte > 0x7f) hasHighBytes = true;
    if (byte >= 0x80 && byte <= 0x9f) hasCp1252Range = true;
  }
  return {
    hasHighBytes,
    hasCp1252Range,
    validUtf8: hasHighBytes ? isValidUtf8(bytes) : true,
  };
}

/**
 * Deterministic byte analysis — no statistics, no guessing.
 *
 *  - pure ASCII            → ascii
 *  - valid multi-byte UTF-8 → utf8
 *  - bytes in 0x80–0x9F     → windows-1252 (ISO-8859-1 cannot represent them)
 *  - anything else          → iso-8859-1
 */
export function detectEncoding(bytes: Buffer): SupportedEncoding {
  if (isAscii(bytes)) return "ascii";
  const evidence = analyzeBytes(bytes);
  if (evidence.validUtf8) return "utf8";
  return evidence.hasCp1252Range ? "windows-1252" : "iso-8859-1";
}
