/**
 * Core encoding vocabulary. Nothing in this file (or in `core/`) may import
 * from the OpenCode SDK — the encoding logic must stay framework independent.
 */

/** Byte-level encodings this plugin can round-trip. */
export type SupportedEncoding =
  "utf8" | "iso-8859-1" | "windows-1252" | "ascii";

export type LineEnding = "LF" | "CRLF" | "CR";

/**
 * Where the resolved encoding came from, in descending priority order.
 * `rule` > `eclipse` > `editorconfig` > `bom` > `detection` > `fallback`.
 */
export type EncodingSource =
  | "rule"
  | "eclipse"
  | "editorconfig"
  | "bom"
  | "detection"
  | "fallback"
  /** The encoding was proven by re-encoding the original bytes (legacy file, no config). */
  | "original-bytes";

export type BomKind = "utf8" | "utf16le" | "utf16be" | null;

export interface FileMetadata {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the project root, always with `/` separators. */
  relativePath: string;
  encoding: SupportedEncoding;
  encodingSource: EncodingSource;
  bom: boolean;
  lineEnding: LineEnding;
  /** True when the file mixes LF/CRLF/CR. Mixed files are never normalized silently. */
  mixedLineEndings: boolean;
  /** Number of bytes of the original file. */
  size: number;
  /** sha256 (hex) of the original bytes — used to detect "did the tool write at all?". */
  hash: string;
  /** Binary or non-text (UTF-16, NUL bytes) — never touched by this plugin. */
  binary: boolean;
}

export interface EncodingResolution {
  encoding: SupportedEncoding;
  source: EncodingSource;
}

export const ENCODING_LABELS: Record<SupportedEncoding, string> = {
  utf8: "UTF-8",
  "iso-8859-1": "ISO-8859-1",
  "windows-1252": "Windows-1252",
  ascii: "ASCII",
};

export const LINE_ENDING_LABELS: Record<LineEnding, string> = {
  LF: "LF",
  CRLF: "CRLF",
  CR: "CR",
};

/** Normalise Windows separators and drop `./` noise. Paths stay relative. */
export function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isSupportedEncoding(
  value: unknown,
): value is SupportedEncoding {
  return (
    value === "utf8" ||
    value === "iso-8859-1" ||
    value === "windows-1252" ||
    value === "ascii"
  );
}

/** Longest alias wins over shorter ones (`utf-8` before `utf8`). */
const CHARSET_ALIASES: ReadonlyArray<readonly [RegExp, SupportedEncoding]> = [
  [/^utf-?8$/i, "utf8"],
  [/^utf-?8[-_]?bom$/i, "utf8"],
  [/^(windows-?1252|cp1252|windows1252)$/i, "windows-1252"],
  [/^(iso-?8859-?1|iso8859_?1|iso_?8859-?1|latin-?1|l1|8859)$/i, "iso-8859-1"],
  [/^(us-?ascii|ascii|iso646-?us)$/i, "ascii"],
];

/**
 * Map an arbitrary charset label (Eclipse prefs, .editorconfig, config rules)
 * onto a supported encoding. Returns undefined for anything we cannot
 * round-trip safely — guessing here would be how files get corrupted.
 */
export function fromCharsetLabel(
  label: string | undefined | null,
): SupportedEncoding | undefined {
  if (!label) return undefined;
  const value = label.trim().replace(/^encode\./i, "");
  for (const [pattern, encoding] of CHARSET_ALIASES) {
    if (pattern.test(value)) return encoding;
  }
  return undefined;
}
