import { matchesEditorConfigGlob } from "./glob.js";
import {
  fromCharsetLabel,
  toPosixPath,
  type LineEnding,
  type SupportedEncoding,
} from "./types.js";

export interface EditorConfigProperties {
  charset?: SupportedEncoding;
  endOfLine?: LineEnding;
}

/** Parse one `.editorconfig` file into ordered sections. */
export function parseEditorConfig(
  content: string,
): Array<{ glob: string; properties: EditorConfigProperties }> {
  const sections: Array<{ glob: string; properties: EditorConfigProperties }> =
    [];
  let current: { glob: string; properties: EditorConfigProperties } | undefined;

  for (const rawLine of content.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      current = { glob: line.slice(1, -1), properties: {} };
      sections.push(current);
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1 || !current) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();

    if (key === "charset") {
      current.properties.charset = fromCharsetLabel(value);
    } else if (key === "end_of_line") {
      if (value === "crlf") current.properties.endOfLine = "CRLF";
      else if (value === "cr") current.properties.endOfLine = "CR";
      else if (value === "lf") current.properties.endOfLine = "LF";
    }
  }

  return sections;
}

export interface EditorConfigEntry {
  /** Directory that owns the `.editorconfig`, relative to the project root. */
  baseDirectory: string;
  sections: Array<{ glob: string; properties: EditorConfigProperties }>;
}

export function resolveEditorConfig(
  entries: ReadonlyArray<EditorConfigEntry>,
  relativePath: string,
): EditorConfigProperties {
  const resolved: EditorConfigProperties = {};
  const normalised = toPosixPath(relativePath);

  // Nearest file wins, so walk from the outermost entry inwards.
  const ordered = [...entries].sort(
    (a, b) => a.baseDirectory.length - b.baseDirectory.length,
  );
  for (const entry of ordered) {
    const base = entry.baseDirectory.replace(/^\.\//, "").replace(/\/$/, "");
    const relativeToBase =
      base && normalised.startsWith(base)
        ? normalised.slice(base.length + 1)
        : normalised;
    if (base && !normalised.startsWith(`${base}/`)) continue;

    for (const section of entry.sections) {
      if (!matchesEditorConfigGlob(section.glob, relativeToBase)) continue;
      if (section.properties.charset)
        resolved.charset = section.properties.charset;
      if (section.properties.endOfLine)
        resolved.endOfLine = section.properties.endOfLine;
    }
  }

  return resolved;
}
