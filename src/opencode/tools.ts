import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { GuardConfig } from "../config.js";
import { decodeBytes, encodeText } from "../core/codec.js";
import { isBinary } from "../core/detect.js";
import { readFileSafe } from "../core/fs-utils.js";
import {
  loadProjectConfig,
  readMetadata,
  type ProjectConfig,
} from "../core/project.js";
import {
  ENCODING_LABELS,
  LINE_ENDING_LABELS,
  toPosixPath,
  type SupportedEncoding,
} from "../core/types.js";
import { isInsideRoot } from "./patch-paths.js";

export interface InspectInput {
  path?: unknown;
}

export interface ScanInput {
  limit?: unknown;
}

export async function inspectPath(
  root: string,
  input: InspectInput,
  config: GuardConfig,
  project?: ProjectConfig,
): Promise<string> {
  const rawPath = typeof input.path === "string" ? input.path : "";
  if (!rawPath.trim()) {
    return 'encoding_inspect requires a `path` argument, for example: encoding_inspect({"path":"src/A.java"}).';
  }

  const absolutePath = resolve(root, toPosixPath(rawPath));
  if (!isInsideRoot(root, absolutePath)) {
    return `Refused: ${rawPath} resolves outside the project root.`;
  }

  const loaded = project ?? (await loadProjectConfig(root, config));
  const result = await readMetadata(absolutePath, loaded, config);
  if (!result) {
    const exists = (await readFileSafe(absolutePath)) !== undefined;
    return exists
      ? `File:\n${rawPath}\n\nProtection:\nSkipped (larger than maxFileBytes = ${config.maxFileBytes})`
      : `File:\n${rawPath}\n\nStatus:\nNot found`;
  }

  const { metadata, payload } = result;
  const roundTrip = metadata.binary
    ? "Skipped (binary)"
    : verifyRoundTrip(payload, metadata.encoding)
      ? "OK"
      : "FAILED — round-trip verification failed";

  return [
    `File:\n${metadata.relativePath}`,
    `Encoding:\n${ENCODING_LABELS[metadata.encoding]}`,
    `Source:\n${describeSource(metadata.encodingSource)}`,
    `BOM:\n${metadata.bom ? "Yes (UTF-8)" : "No"}`,
    `Line endings:\n${metadata.mixedLineEndings ? `${LINE_ENDING_LABELS[metadata.lineEnding]} (mixed)` : LINE_ENDING_LABELS[metadata.lineEnding]}`,
    `Round-trip:\n${roundTrip}`,
    `Protection:\n${metadata.binary || metadata.size > config.maxFileBytes ? "Inactive" : "Active"}`,
  ].join("\n\n");
}

function describeSource(source: string): string {
  switch (source) {
    case "rule":
      return "Plugin rule";
    case "eclipse":
      return "Eclipse project preference";
    case "editorconfig":
      return ".editorconfig charset";
    case "bom":
      return "UTF-8 byte-order mark";
    case "original-bytes":
      return "Byte analysis (legacy encoding proven)";
    case "detection":
      return "Byte analysis";
    default:
      return "Configured fallback";
  }
}

/** Round-trip check: re-encode the decoded text and compare with the bytes on disk. */
function verifyRoundTrip(
  payload: Buffer,
  encoding: SupportedEncoding,
): boolean {
  try {
    return encodeText(decodeBytes(payload, encoding), encoding).equals(payload);
  } catch {
    return false;
  }
}

export interface ScanResult {
  counts: Record<string, number>;
  total: number;
  mixed: boolean;
  eclipseDetected: boolean;
  atRisk: Array<{ path: string; reason: string }>;
  truncated: boolean;
}

export async function scanProject(
  root: string,
  input: ScanInput,
  config: GuardConfig,
  project?: ProjectConfig,
): Promise<{ report: string; result: ScanResult }> {
  const limit =
    typeof input.limit === "number" && input.limit > 0
      ? Math.floor(input.limit)
      : 2000;
  const loaded = project ?? (await loadProjectConfig(root, config));
  const ignore = new Set(config.ignore);

  const counts: Record<string, number> = {
    "UTF-8": 0,
    "UTF-8 BOM": 0,
    "ISO-8859-1": 0,
    "Windows-1252": 0,
    ASCII: 0,
    Unknown: 0,
  };
  const atRisk: ScanResult["atRisk"] = [];
  const seen = new Set<string>();
  let total = 0;
  let truncated = false;

  const queue = [root];
  while (queue.length > 0 && !truncated) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries) {
      if (total >= limit) {
        truncated = true;
        break;
      }
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) queue.push(child);
        continue;
      }
      if (!entry.isFile()) continue;

      total++;
      const relativePath = toPosixPath(relative(root, child));
      const bytes = await readFileSafe(child);
      if (bytes === undefined) continue;

      if (bytes.length > config.maxFileBytes || isBinary(bytes)) {
        atRisk.push({ path: relativePath, reason: "binary or oversized" });
        continue;
      }

      const metadata = await readMetadata(child, loaded, config);
      if (!metadata) {
        counts.Unknown = (counts.Unknown ?? 0) + 1;
        continue;
      }
      const label = metadata.metadata.bom
        ? "UTF-8 BOM"
        : ENCODING_LABELS[metadata.metadata.encoding];
      counts[label] = (counts[label] ?? 0) + 1;
      seen.add(metadata.metadata.encoding);
    }
  }

  const atRiskPreview = atRisk
    .slice(0, 10)
    .map((item) => `  ${item.path} — ${item.reason}`);
  const report = [
    "Encoding Guard — Project Report",
    "",
    ...Object.entries(counts).map(
      ([label, count]) => `${label.padEnd(16)}${count}`,
    ),
    "",
    `Files scanned:\n${total}${truncated ? " (limit reached)" : ""}`,
    `Mixed-encoding repository detected.\n${seen.size > 1 ? "Yes" : "No"}`,
    `Eclipse encoding configuration:\n${loaded.eclipse.size > 0 ? "Detected" : "Not detected"}`,
    `Files at risk:\n${atRisk.length}${atRiskPreview.length > 0 ? `\n${atRiskPreview.join("\n")}` : ""}`,
  ].join("\n");

  return {
    report,
    result: {
      counts,
      total,
      mixed: seen.size > 1,
      eclipseDetected: loaded.eclipse.size > 0,
      atRisk,
      truncated,
    },
  };
}
