import {
  fromCharsetLabel,
  toPosixPath,
  type SupportedEncoding,
} from "./types.js";

export const ECLIPSE_PREFS_PATH = ".settings/org.eclipse.core.resources.prefs";
const DEFAULT_ENCODING_KEY = "eclipse.preferences.core.defaultEncoding";

export interface EclipsePreferences {
  /** Project-wide default from `eclipse.preferences.core.defaultEncoding`. */
  projectDefault?: SupportedEncoding;
  /**
   * Workspace-relative resource entries, e.g. `/Legacy/src=encode.ISO-8859-1`.
   * Paths are normalised without a leading slash and lowercased for matching.
   */
  resources: Array<{ path: string; encoding: SupportedEncoding }>;
}

/**
 * Parse an `org.eclipse.core.resources.prefs` file.
 *
 * Real shape (comments start with `#`):
 *
 *   #Wed Oct 08 09:12:00 CEST 2026
 *   eclipse.preferences.core.defaultEncoding=UTF-8
 *   /Legacy=encode.ISO-8859-1
 *   /Legacy/src/main/java=encode.windows-1252
 *   /Legacy/src/main/java/Servicio.java=ISO-8859-1
 *
 * Both the `encode.<charset>` value and a bare charset are accepted, as are the
 * newer Eclipse versions that dropped the prefix. Charsets we cannot round-trip
 * safely (Shift_JIS, UTF-16, …) are skipped instead of guessed.
 */
export function parseEclipsePreferences(content: string): EclipsePreferences {
  const preferences: EclipsePreferences = { resources: [] };

  for (const rawLine of content.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    const encoding = fromCharsetLabel(value);
    if (!encoding) continue;

    if (key === DEFAULT_ENCODING_KEY) {
      preferences.projectDefault = encoding;
    } else if (key.startsWith("/")) {
      preferences.resources.push({
        path: toPosixPath(key).replace(/^\//, "").toLowerCase(),
        encoding,
      });
    }
  }

  return preferences;
}

function isUnder(key: string, candidate: string): boolean {
  return candidate === key || candidate.startsWith(`${key}/`);
}

/**
 * Most specific declaration wins: file > deepest folder > project > default.
 *
 * Eclipse keys are workspace-relative, so `/Legacy` matches every file of that
 * project; keys written without the project prefix are also accepted.
 */
export function resolveEclipseEncoding(
  preferences: EclipsePreferences,
  projectName: string,
  relativePath: string,
):
  | { encoding: SupportedEncoding; source: "eclipse"; matched: string }
  | undefined {
  const normalised = toPosixPath(relativePath).toLowerCase();
  const projectKey = projectName.toLowerCase();
  const insideProject = normalised.startsWith(`${projectKey}/`);
  const withinProject = insideProject
    ? normalised.slice(projectKey.length + 1)
    : normalised;
  const workspacePath = projectKey
    ? `${projectKey}/${withinProject}`
    : normalised;

  // Resource entries belong to one project. A file outside it must not inherit
  // them, otherwise `/Legacy` would leak into every sibling project.
  const resourceScope = !projectKey || insideProject;
  let best:
    { encoding: SupportedEncoding; depth: number; matched: string } | undefined;

  for (const resource of preferences.resources) {
    const key = resource.path;
    const matchesWorkspace = isUnder(key, workspacePath);
    const matchesProject = key.startsWith(`${projectKey}/`)
      ? isUnder(key.slice(projectKey.length + 1), withinProject)
      : isUnder(key, withinProject);
    if (!matchesWorkspace && !matchesProject) continue;
    if (!resourceScope) continue;

    const depth = key.split("/").filter(Boolean).length;
    if (!best || depth > best.depth) {
      best = { encoding: resource.encoding, depth, matched: key };
    }
  }

  if (best) {
    return {
      encoding: best.encoding,
      source: "eclipse",
      matched: best.matched,
    };
  }
  if (preferences.projectDefault) {
    return {
      encoding: preferences.projectDefault,
      source: "eclipse",
      matched: DEFAULT_ENCODING_KEY,
    };
  }
  return undefined;
}
