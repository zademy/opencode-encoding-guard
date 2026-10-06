import iconv from "iconv-lite";
import type { SupportedEncoding } from "./types.js";

/**
 * iconv-lite keeps the ISO-8859-1 / Windows-1252 distinction that a naive
 * `Buffer.toString("latin1")` loses: bytes 0x80–0x9F map to smart quotes and
 * the euro sign in Windows-1252 but are undefined in ISO-8859-1.
 */
const ICONV_NAME: Record<SupportedEncoding, string> = {
  utf8: "utf8",
  "iso-8859-1": "iso-8859-1",
  "windows-1252": "windows-1252",
  ascii: "ascii",
};

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function encodeText(text: string, encoding: SupportedEncoding): Buffer {
  return iconv.encode(text, ICONV_NAME[encoding]);
}

/** Decode without stripping BOM — BOM handling is explicit via `stripBom`. */
export function decodeBytes(
  bytes: Buffer,
  encoding: SupportedEncoding,
): string {
  return iconv.decode(bytes, ICONV_NAME[encoding]);
}

export function stripBom(bytes: Buffer): Buffer {
  return bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
}

/** True when `encode → decode` reproduces the input exactly. */
export function canEncode(text: string, encoding: SupportedEncoding): boolean {
  return roundTrips(text, encoding);
}

function roundTrips(text: string, encoding: SupportedEncoding): boolean {
  return decodeBytes(encodeText(text, encoding), encoding) === text;
}

/**
 * Characters that cannot be represented in `encoding`.
 *
 * iconv-lite replaces unmappable characters with `?` instead of failing, so the
 * only way to detect loss is to compare a round-trip. The fast path is one
 * encode+decode of the whole string; the slow path (per character) only runs
 * when something is actually wrong, to build a useful error message.
 */
export function unencodableCharacters(
  text: string,
  encoding: SupportedEncoding,
): string[] {
  if (roundTrips(text, encoding)) return [];
  const offending = new Set<string>();
  for (const character of text) {
    if (character === "\n" || character === "\r") continue;
    if (!roundTrips(character, encoding)) offending.add(character);
  }
  return [...offending];
}

/** Format a character as `U+2705 ✅` for user-facing errors. */
export function describeCharacter(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
  const printable =
    character.codePointAt(0)! > 0x20 && character !== "\uFFFD"
      ? ` ${character}`
      : "";
  return `U+${hex}${printable}`;
}

export function describeUnencodable(
  text: string,
  encoding: SupportedEncoding,
): string {
  return unencodableCharacters(text, encoding)
    .slice(0, 10)
    .map(describeCharacter)
    .join(", ");
}
