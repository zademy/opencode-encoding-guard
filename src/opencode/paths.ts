import { parsePatch, resolvePatchPath, type PatchFile } from "./patch-paths.js";

/** Tools that mutate files on disk. `apply_patch` is renamed to `patch` in OpenCode v2. */
const MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "multifileEdit",
]);

const PATH_KEYS = [
  "filePath",
  "file_path",
  "path",
  "file",
  "filename",
  "targetFile",
];

export type MutationAction = "update" | "add" | "delete";

export interface MutationTarget {
  absolutePath: string;
  rawPath: string;
  action: MutationAction;
  /** Text the operation introduces — checked for representability before running. */
  addedText: string[];
  moveTo?: string;
  moveToRaw?: string;
}

export function isMutatingTool(tool: string): boolean {
  return MUTATING_TOOLS.has(tool);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** New text introduced by an `edit`/`write` call, used for representability checks. */
function readAddedText(tool: string, input: Record<string, unknown>): string[] {
  const added: string[] = [];

  if (tool === "write") {
    const content = input.content ?? input.text ?? input.contents;
    if (typeof content === "string") added.push(content);
    return added;
  }

  const newString = input.newString ?? input.new_string ?? input.replacement;
  if (typeof newString === "string") added.push(newString);

  // Multi-edit variants: `edits: [{ oldString, newString }, ...]`
  const edits = input.edits ?? input.changes;
  if (Array.isArray(edits)) {
    for (const entry of edits) {
      const edit = asRecord(entry);
      const text = edit
        ? (edit.newString ?? edit.new_string ?? edit.content)
        : undefined;
      if (typeof text === "string") added.push(text);
    }
  }

  return added;
}

/**
 * Every file a mutating tool call will touch, with the text it introduces.
 * Paths come from the input fields for `edit`/`write` and from the patch parser
 * for `patch`/`apply_patch` — the plugin never assumes `filePath` is present.
 */
export function extractMutationTargets(
  tool: string,
  input: unknown,
  root: string,
): MutationTarget[] {
  const record = asRecord(input);
  if (!record) return [];

  const patchText = readString(record, ["patchText", "patch", "patch_text"]);
  const looksLikePatch =
    tool === "patch" || tool === "apply_patch" || patchText !== undefined;
  if (looksLikePatch && patchText) {
    return parsePatch(patchText, root).map(patchFileToTarget);
  }

  const rawPath = readString(record, PATH_KEYS);
  if (!rawPath) return [];

  const moveToRaw = readString(record, [
    "moveTo",
    "move_to",
    "newPath",
    "destination",
  ]);

  return [
    {
      absolutePath: resolvePatchPath(root, rawPath),
      rawPath,
      action: tool === "write" ? "add" : "update",
      addedText: readAddedText(tool, record),
      ...(moveToRaw
        ? { moveTo: resolvePatchPath(root, moveToRaw), moveToRaw }
        : {}),
    },
  ];
}

function patchFileToTarget(file: PatchFile): MutationTarget {
  return {
    absolutePath: file.absolutePath,
    rawPath: file.rawPath,
    action: file.action,
    addedText: file.addedLines,
    ...(file.moveTo ? { moveTo: file.moveTo, moveToRaw: file.moveToRaw } : {}),
  };
}
