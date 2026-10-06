import { resolve, sep } from "node:path";
import { toPosixPath } from "../core/types.js";

/** Markers understood by the OpenCode patch tool. */
const FILE_MARKERS = [
  { marker: "*** Add File:", action: "add" as const },
  { marker: "*** Update File:", action: "update" as const },
  { marker: "*** Delete File:", action: "delete" as const },
];

export interface PatchFile {
  /** Path exactly as written in the patch. */
  rawPath: string;
  /** Absolute path resolved against the project root. */
  absolutePath: string;
  action: "add" | "update" | "delete";
  /** Destination of `*** Move to:` for renames (absolute). */
  moveTo?: string;
  moveToRaw?: string;
  /** Lines the patch introduces — the only new text that needs representability checks. */
  addedLines: string[];
  /** Removed lines, kept for reporting. */
  removedLines: string[];
}

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

/**
 * Parse a patch payload into the files it affects.
 *
 * Handles the OpenAI/OpenCode patch envelope:
 *
 *   *** Begin Patch
 *   *** Update File: src/main/java/A.java
 *   *** Move to: src/main/java/B.java
 *   @@ class A
 *   -int a = 1;
 *   +int a = 2;
 *   *** Add File: src/main/java/C.java
 *   +package com.example;
 *   *** Delete File: src/main/java/D.java
 *   *** End Patch
 *
 * A plain unified diff (`--- a/x` / `+++ b/x`) is also accepted.
 */
export function parsePatch(patchText: string, root: string): PatchFile[] {
  const lines = patchText.split(/\r\n|\n|\r/);
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;

  const ensure = () => {
    if (!current)
      throw new PatchParseError("Patch contains hunks before any file marker");
    return current;
  };

  for (const line of lines) {
    const trimmedEnd = line.replace(/\s+$/, "");

    const marker = FILE_MARKERS.find((entry) =>
      trimmedEnd.startsWith(entry.marker),
    );
    if (marker) {
      const rawPath = trimmedEnd.slice(marker.marker.length).trim();
      if (!rawPath)
        throw new PatchParseError(`Missing path after "${marker.marker}"`);
      current = {
        rawPath,
        absolutePath: resolvePatchPath(root, rawPath),
        action: marker.action,
        addedLines: [],
        removedLines: [],
      };
      files.push(current);
      continue;
    }

    if (trimmedEnd.startsWith("*** Move to:")) {
      const destination = trimmedEnd.slice("*** Move to:".length).trim();
      if (!destination)
        throw new PatchParseError('Missing path after "*** Move to:"');
      ensure();
      current!.moveToRaw = destination;
      current!.moveTo = resolvePatchPath(root, destination);
      continue;
    }

    if (
      trimmedEnd.startsWith("*** Begin Patch") ||
      trimmedEnd.startsWith("*** End Patch") ||
      trimmedEnd === "***"
    ) {
      continue;
    }

    // Unified diff headers. Git writes `--- a/path` / `+++ b/path`; the `+++`
    // side is the destination and wins when both spell the same file.
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const isDestination = line.startsWith("+++ ");
      const rawPath = stripDiffPrefix(line.slice(4).trim());
      if (rawPath === "/dev/null") {
        if (!isDestination) current = undefined;
        continue;
      }
      if (isDestination) {
        current =
          files.find(
            (file) => file.rawPath === rawPath && file.action === "update",
          ) ?? createUpdate(root, rawPath, files);
      } else if (!current) {
        current = createUpdate(root, rawPath, files);
      }
      continue;
    }

    if (line.startsWith("@@")) {
      ensure();
      continue;
    }

    if (current && line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
      continue;
    }
    if (current && line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
      continue;
    }
    if (current && (line.startsWith(" ") || line === "")) {
      // Context line: carries no new text.
      continue;
    }
    if (current && /^[A-Za-z\\]/.test(line) && !line.startsWith("\\")) {
      // Continuation of an Add File block, where lines may omit the `+` prefix.
      if (current.action === "add") current.addedLines.push(line);
    }
  }

  if (files.length === 0) {
    throw new PatchParseError("Patch contains no recognisable file markers");
  }

  return files;
}

/** `a/src/A.java` / `b/src/A.java` → `src/A.java`. */
function stripDiffPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function createUpdate(
  root: string,
  rawPath: string,
  files: PatchFile[],
): PatchFile {
  const file: PatchFile = {
    rawPath,
    absolutePath: resolvePatchPath(root, rawPath),
    action: "update",
    addedLines: [],
    removedLines: [],
  };
  files.push(file);
  return file;
}

/** Absolute path for a patch entry, tolerating Windows drive letters and separators. */
export function resolvePatchPath(root: string, rawPath: string): string {
  let candidate = toPosixPath(rawPath.trim());
  if (/^[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(2);
  if (candidate.startsWith("./")) candidate = candidate.slice(2);
  return resolve(root, candidate);
}

export interface PatchImpact {
  added: string[];
  updated: string[];
  moved: Array<{ from: string; to: string }>;
  deleted: string[];
}

/** Grouped view used by the inspection tool. */
export function summariseImpact(files: ReadonlyArray<PatchFile>): PatchImpact {
  const impact: PatchImpact = {
    added: [],
    updated: [],
    moved: [],
    deleted: [],
  };
  for (const file of files) {
    if (file.action === "add") impact.added.push(file.absolutePath);
    else if (file.action === "delete") impact.deleted.push(file.absolutePath);
    else impact.updated.push(file.absolutePath);
    if (file.moveTo)
      impact.moved.push({ from: file.absolutePath, to: file.moveTo });
  }
  return impact;
}

/** True when `candidate` is the root itself or lives inside it. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const normalisedRoot = resolve(root);
  const normalisedCandidate = resolve(normalisedRoot, candidate);
  if (normalisedCandidate === normalisedRoot) return true;
  return normalisedCandidate.startsWith(
    normalisedRoot.endsWith(sep) ? normalisedRoot : normalisedRoot + sep,
  );
}
