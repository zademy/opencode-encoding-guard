import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import {
  parseEditorConfig,
  resolveEditorConfig,
  type EditorConfigEntry,
  type EditorConfigProperties,
} from "./editorconfig.js";
import { ECLIPSE_PREFS_PATH } from "./eclipse.js";
import {
  parseEclipsePreferences,
  resolveEclipseEncoding,
  type EclipsePreferences,
} from "./eclipse.js";
import { detectBom, detectEncoding, isBinary } from "./detect.js";
import { decodeBytes, stripBom } from "./codec.js";
import { detectLineEndings } from "./line-endings.js";
import { matchesGlob } from "./glob.js";
import { readFileSafe } from "./fs-utils.js";
import {
  toPosixPath,
  type EncodingResolution,
  type FileMetadata,
  type SupportedEncoding,
} from "./types.js";
import type { GuardConfig } from "../config.js";

export interface ProjectConfig {
  root: string;
  eclipse: Map<string, EclipsePreferences>;
  editorconfig: EditorConfigEntry[];
}

function keyFor(baseDirectory: string): string {
  return baseDirectory === "" ? "." : baseDirectory;
}

export async function loadProjectConfig(
  root: string,
  config: GuardConfig,
): Promise<ProjectConfig> {
  const eclipse = new Map<string, EclipsePreferences>();
  if (config.eclipse.enabled) {
    for (const baseDirectory of await findEclipseProjects(root, config)) {
      const prefsPath = join(root, baseDirectory, ECLIPSE_PREFS_PATH);
      const content = await readFileSafe(prefsPath);
      if (content === undefined) continue;
      eclipse.set(
        keyFor(baseDirectory),
        parseEclipsePreferences(content.toString("utf8")),
      );
    }
  }

  let editorconfig: EditorConfigEntry[] = [];
  if (config.editorconfig.enabled) {
    editorconfig = await findEditorConfigFiles(root);
  }

  return { root, eclipse, editorconfig };
}

async function findEclipseProjects(
  root: string,
  config: GuardConfig,
): Promise<string[]> {
  const found: string[] = [""];
  const queue = [root];
  const maxDepth = config.maxConfigScanDepth;

  while (queue.length > 0) {
    const directory = queue.shift()!;
    if (await pathExists(join(directory, ECLIPSE_PREFS_PATH))) {
      found.push(toPosixPath(relative(root, directory)));
    }
    if (found.length > 512) break;
    for (const child of await listDirectories(directory, config)) {
      const depth = relative(root, child).split(sep).length;
      if (depth <= maxDepth) queue.push(child);
    }
  }

  // Deduplicate: a nested `.settings` belongs to its own project, and the empty
  // string represents the workspace root itself.
  return [...new Set(found)];
}

async function findEditorConfigFiles(
  root: string,
): Promise<EditorConfigEntry[]> {
  const entries: EditorConfigEntry[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const content = await readFileSafe(join(directory, ".editorconfig"));
    if (content !== undefined) {
      const text = content.toString("utf8");
      entries.push({
        baseDirectory: toPosixPath(relative(root, directory)),
        sections: parseEditorConfig(text),
      });
      // A `.editorconfig` with `root = true` stops the upward walk.
      if (/^\s*root\s*=\s*true/im.test(text)) continue;
    }
    const parent = dirname(directory);
    if (parent !== directory && directory !== root) queue.push(parent);
  }
  return entries;
}

async function listDirectories(directory: string, config: GuardConfig) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter(
      (entry) => entry.isDirectory() && !config.ignore.includes(entry.name),
    )
    .map((entry) => join(directory, entry.name));
}

async function pathExists(filePath: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  /** Force an encoding (mode `force` in config rules). */
  forced?: SupportedEncoding;
}

/**
 * Deterministic resolution order from the spec:
 * rule → eclipse → editorconfig → BOM → byte analysis → fallback.
 */
export function resolveEncoding(
  relativePath: string,
  bytes: Buffer | undefined,
  project: ProjectConfig,
  config: GuardConfig,
  options: ResolveOptions = {},
): EncodingResolution {
  const rule = matchRule(relativePath, project.root, config);
  if (rule) return { encoding: rule, source: "rule" };
  if (options.forced) return { encoding: options.forced, source: "rule" };

  for (const scope of eclipseScopes(relativePath)) {
    const preferences = project.eclipse.get(keyFor(scope));
    if (!preferences) continue;
    // The scope that owns `.settings/` *is* the Eclipse project name, and its
    // preference keys are workspace-relative (`/Project/src=...`).
    const resolved = resolveEclipseEncoding(preferences, scope, relativePath);
    if (resolved) return { encoding: resolved.encoding, source: "eclipse" };
  }

  const editorConfig: EditorConfigProperties = resolveEditorConfig(
    project.editorconfig,
    relativePath,
  );
  if (editorConfig.charset)
    return { encoding: editorConfig.charset, source: "editorconfig" };

  if (bytes) {
    const bom = detectBom(bytes);
    if (bom === "utf8") return { encoding: "utf8", source: "bom" };
  }

  if (bytes) {
    const detected = detectEncoding(stripBom(bytes));
    // Legacy bytes that decode cleanly in a single-byte encoding are reported
    // as `original-bytes`: we can prove the encoding instead of guessing it.
    const source = detected === "utf8" ? "detection" : "original-bytes";
    return { encoding: detected, source };
  }

  return { encoding: config.fallbackEncoding, source: "fallback" };
}

function matchRule(
  relativePath: string,
  root: string,
  config: GuardConfig,
): SupportedEncoding | undefined {
  for (const rule of config.rules) {
    if (rule.encoding === "preserve") continue;
    const matches =
      matchesGlob(rule.glob, relativePath) ||
      matchesGlob(rule.glob, `${root}/${relativePath}`);
    if (matches) return rule.encoding;
  }
  return undefined;
}

/** Directory scopes that may hold a `.settings/` folder, nearest first. */
function eclipseScopes(relativePath: string): string[] {
  const scopes: string[] = [""];
  const parts = toPosixPath(relativePath).split("/");
  for (let index = 0; index < parts.length; index++) {
    scopes.push(parts.slice(0, index + 1).join("/"));
  }
  // Nearest (most specific) scope first so file-level entries win.
  return [...new Set(scopes)].sort((a, b) => b.length - a.length);
}

export interface ReadMetadataResult {
  metadata: FileMetadata;
  /** Bytes without a UTF-8 BOM. */
  payload: Buffer;
}

export async function readMetadata(
  absolutePath: string,
  project: ProjectConfig,
  config: GuardConfig,
): Promise<ReadMetadataResult | undefined> {
  const bytes = await readFileSafe(absolutePath);
  if (bytes === undefined) return undefined;
  if (bytes.length > config.maxFileBytes) return undefined;

  const relativePath = toPosixPath(relative(project.root, absolutePath));
  const bomKind = detectBom(bytes);
  const binary = isBinary(bytes);
  const payload = stripBom(bytes);

  const resolution = resolveEncoding(relativePath, bytes, project, config);
  // For legacy encodings the declared/resolved encoding wins; the byte analysis
  // only provides the fallback text used for detection.
  const text = decodeBytes(payload, resolution.encoding);
  const lineEndings = detectLineEndings(text);

  return {
    payload,
    metadata: {
      path: absolutePath,
      relativePath,
      encoding: resolution.encoding,
      encodingSource: resolution.source,
      bom: bomKind === "utf8",
      lineEnding: lineEndings.lineEnding,
      mixedLineEndings: lineEndings.mixed,
      size: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
      binary,
    },
  };
}
