import { relative } from "node:path";
import type { GuardConfig } from "../config.js";
import {
  canEncode,
  decodeBytes,
  describeUnencodable,
  encodeText,
  stripBom,
  UTF8_BOM,
} from "../core/codec.js";
import { analyzeBytes, isBinary } from "../core/detect.js";
import { atomicWrite, readFileSafe } from "../core/fs-utils.js";
import { applyLineEnding, hasLineEnding } from "../core/line-endings.js";
import {
  loadProjectConfig,
  readMetadata,
  resolveEncoding,
  type ProjectConfig,
} from "../core/project.js";
import {
  ENCODING_LABELS,
  LINE_ENDING_LABELS,
  toPosixPath,
  type FileMetadata,
  type SupportedEncoding,
} from "../core/types.js";
import { isInsideRoot } from "./patch-paths.js";
import {
  extractMutationTargets,
  isMutatingTool,
  type MutationTarget,
} from "./paths.js";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(debug: boolean): Logger {
  const prefix = "[encoding-guard]";
  return {
    debug: (message) => {
      if (debug) console.log(`${prefix} ${message}`);
    },
    info: (message) => console.log(`${prefix} ${message}`),
    warn: (message) => console.warn(`${prefix} ${message}`),
    error: (message) => console.error(`${prefix} ${message}`),
  };
}

interface CapturedFile {
  absolutePath: string;
  relativePath: string;
  /** Bytes as they were before the tool ran (absent for new files). */
  originalBytes?: Buffer;
  metadata: FileMetadata;
  targetEncoding: SupportedEncoding;
  /** UTF-8 bytes written during `before` so the tool reads correct text. */
  swapBytes?: Buffer;
  /** True when the file did not exist before the call. */
  isNew: boolean;
  action: MutationTarget["action"];
  moveTo?: string;
  addedText: string[];
}

interface Operation {
  id: string;
  tool: string;
  startedAt: number;
  files: Map<string, CapturedFile>;
}

/** Operation-scoped state keyed by Tool.CallID — never a single global variable. */
class OperationRegistry {
  private readonly operations = new Map<string, Operation>();

  start(id: string, tool: string): Operation {
    const operation: Operation = {
      id,
      tool,
      startedAt: Date.now(),
      files: new Map(),
    };
    this.operations.set(id, operation);
    this.sweep();
    return operation;
  }

  take(id: string): Operation | undefined {
    const operation = this.operations.get(id);
    this.operations.delete(id);
    return operation;
  }

  private sweep(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, operation] of this.operations) {
      if (operation.startedAt < cutoff) this.operations.delete(id);
    }
  }

}

export class GuardBlockedError extends Error {
  readonly code = "ENCODING_GUARD_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "GuardBlockedError";
  }
}

export interface GuardOptions {
  root: string;
  config: GuardConfig;
  logger?: Logger;
}

export interface GuardEvent {
  tool: string;
  id: string;
  input: unknown;
}

export interface GuardResultEvent extends GuardEvent {
  status: "completed" | "error";
}

/**
 * Encoding guard.
 *
 * Root cause of legacy corruption: OpenCode's file tools read and write UTF-8.
 * A legacy file decoded as UTF-8 becomes U+FFFD on read — the original byte is
 * gone before any encoding conversion could happen. So the guard keeps the tool
 * inside UTF-8 while it works and owns the bytes around the operation:
 *
 *   before → snapshot bytes + metadata, rewrite the file as exact UTF-8
 *   after  → re-encode to the original encoding, line endings and BOM
 *
 * When the tool made no change at all, the snapshot is restored byte for byte so
 * Git never sees a diff.
 */
export class EncodingGuard {
  private readonly root: string;
  private readonly config: GuardConfig;
  private readonly log: Logger;
  private readonly registry = new OperationRegistry();
  private project?: ProjectConfig;

  constructor(options: GuardOptions) {
    this.root = options.root;
    this.config = options.config;
    this.log = options.logger ?? createLogger(options.config.debug);
  }

  private async projectConfig(): Promise<ProjectConfig> {
    if (!this.project) {
      this.project = await loadProjectConfig(this.root, this.config);
      this.log.debug(
        `project config loaded (eclipse: ${[...this.project.eclipse.keys()].join(",") || "none"})`,
      );
    }
    return this.project;
  }

  /** Drop cached project configuration so edits to `.settings` take effect. */
  invalidate(): void {
    this.project = undefined;
  }

  private relativePath(absolutePath: string): string {
    return toPosixPath(relative(this.root, absolutePath));
  }

  /**
   * `execute.before`. Throwing here aborts the tool call, which is how the guard
   * blocks a write it cannot represent safely.
   */
  async before(event: GuardEvent): Promise<void> {
    if (!this.config.enabled) return;
    if (!isMutatingTool(event.tool)) return;

    const targets = extractMutationTargets(event.tool, event.input, this.root);
    if (targets.length === 0) {
      this.log.debug(`${event.tool}: no file targets resolved from input`);
      return;
    }

    const project = await this.projectConfig();
    const operation = this.registry.start(event.id, event.tool);

    for (const target of targets) {
      const insideRoot = isInsideRoot(this.root, target.absolutePath);
      if (!insideRoot) {
        this.log.warn(
          `refusing to protect path outside the project root: ${target.rawPath}`,
        );
        continue;
      }

      const captured = await this.capture(project, target);
      if (!captured) continue;
      operation.files.set(captured.absolutePath, captured);
    }

    if (operation.files.size === 0) {
      this.registry.take(event.id);
      return;
    }

    // Validate before touching anything on disk so a blocked write leaves the
    // working tree exactly as it was.
    this.assertRepresentable(operation);

    this.log.debug(
      `captured metadata for ${operation.files.size} file(s): ` +
        [...operation.files.values()]
          .map(
            (file) =>
              `${file.relativePath} (${ENCODING_LABELS[file.targetEncoding]})`,
          )
          .join(", "),
    );

    await this.stage(operation);
  }

  private async capture(
    project: ProjectConfig,
    target: MutationTarget,
  ): Promise<CapturedFile | undefined> {
    const relativePath = this.relativePath(target.absolutePath);
    const existingBytes = await readFileSafe(target.absolutePath);

    // A file that does not exist yet has no original encoding: the target is
    // resolved from project configuration only, never from its own UTF-8 bytes.
    if (existingBytes === undefined && target.action !== "delete") {
      const content = target.addedText.join("\n");
      const encoding = this.resolveNewFileEncoding(project, relativePath);
      return {
        absolutePath: target.absolutePath,
        relativePath,
        metadata: {
          path: target.absolutePath,
          relativePath,
          encoding,
          encodingSource: "fallback",
          bom: false,
          lineEnding: "LF",
          mixedLineEndings: false,
          size: 0,
          hash: "",
          binary: isBinary(Buffer.from(content, "utf8")),
        },
        targetEncoding: encoding,
        isNew: true,
        action: target.action,
        addedText: target.addedText,
        ...(target.moveTo ? { moveTo: target.moveTo } : {}),
      };
    }

    if (existingBytes && existingBytes.length > this.config.maxFileBytes) {
      this.log.warn(
        `skipping ${relativePath}: ${existingBytes.length} bytes exceeds maxFileBytes (${this.config.maxFileBytes})`,
      );
      return undefined;
    }

    const result = await readMetadata(
      target.absolutePath,
      project,
      this.config,
    );

    if (target.action === "delete") {
      if (!result) return undefined;
      return {
        absolutePath: target.absolutePath,
        relativePath,
        originalBytes: existingBytes,
        metadata: result.metadata,
        targetEncoding: result.metadata.encoding,
        isNew: false,
        action: "delete",
        addedText: [],
        ...(target.moveTo ? { moveTo: target.moveTo } : {}),
      };
    }

    const metadata = result?.metadata;
    if (!metadata) return undefined;
    if (metadata.binary) {
      this.log.debug(`skipping binary file ${relativePath}`);
      return undefined;
    }

    return {
      absolutePath: target.absolutePath,
      relativePath,
      originalBytes: existingBytes,
      metadata,
      targetEncoding: metadata.encoding,
      isNew: false,
      action: target.action,
      addedText: target.addedText,
      ...(target.moveTo ? { moveTo: target.moveTo } : {}),
    };
  }

  /**
   * Encoding for a file that does not exist yet: explicit rule → Eclipse →
   * .editorconfig → `newFileEncoding` → fallback. Byte analysis is deliberately
   * skipped so a new UTF-8 payload cannot make a legacy folder look UTF-8.
   */
  private resolveNewFileEncoding(
    project: ProjectConfig,
    relativePath: string,
  ): SupportedEncoding {
    if (this.config.newFileEncoding !== "inherit") {
      return this.config.newFileEncoding;
    }
    return resolveEncoding(relativePath, undefined, project, this.config)
      .encoding;
  }

  /** Fail closed: refuse the call when the new text cannot survive the encoding. */
  private assertRepresentable(operation: Operation): void {
    const problems: string[] = [];

    for (const file of operation.files.values()) {
      if (file.action === "delete") continue;
      if (file.targetEncoding === "utf8") continue;
      for (const text of file.addedText) {
        if (text.length === 0) continue;
        if (!canEncode(text, file.targetEncoding)) {
          problems.push(
            `File:\n${file.relativePath}\n\nOriginal encoding:\n${ENCODING_LABELS[file.targetEncoding]}\n\n` +
              `Unsupported character:\n${describeUnencodable(text, file.targetEncoding)}\n\n` +
              `No file corruption was allowed.`,
          );
        }
      }
    }

    if (problems.length === 0) return;

    const header =
      `Encoding Guard blocked an unsafe write.\n\n${problems.join("\n\n")}\n\n` +
      `Use a representable alternative (for example "OK", "[OK]" or a short ASCII label) ` +
      `or migrate the file encoding explicitly.`;

    if (
      this.config.unsupportedCharacters === "block" &&
      this.config.mode === "preserve"
    ) {
      throw new GuardBlockedError(header);
    }

    this.log.warn(
      `${header}\n(policy: ${this.config.unsupportedCharacters} — not blocking)`,
    );
  }

  /**
   * Rewrite every legacy file as UTF-8 so the tool reads correct text.
   * Only files that are actually at risk (non-ASCII bytes in a non-UTF-8
   * encoding) are touched; pure ASCII needs no staging.
   */
  private async stage(operation: Operation): Promise<void> {
    for (const file of operation.files.values()) {
      if (file.isNew || file.action === "delete") continue;
      if (file.targetEncoding === "utf8" || !file.originalBytes) continue;

      const evidence = analyzeBytes(file.originalBytes);
      if (!evidence.hasHighBytes) continue;

      let text: string;
      try {
        text = decodeStrict(file.originalBytes, file.targetEncoding);
      } catch (error) {
        this.log.warn(
          `cannot stage ${file.relativePath}: ${(error as Error).message}. File left untouched.`,
        );
        continue;
      }

      const staged = encodeText(text, "utf8");
      await atomicWrite(file.absolutePath, staged);
      file.swapBytes = staged;
      this.log.debug(
        `staged ${file.relativePath} as UTF-8 for the duration of the operation`,
      );
    }
  }

  /** `execute.after`. Restores encoding, line endings and BOM for every captured file. */
  async after(event: GuardResultEvent): Promise<void> {
    if (!this.config.enabled) return;
    const operation = this.registry.take(event.id);
    if (!operation) return;

    for (const file of operation.files.values()) {
      try {
        await this.restore(file);
      } catch (error) {
        // Never leave a file half transcoded: put the original bytes back.
        await this.rollback(file);
        this.log.error(
          `failed to restore ${file.relativePath}: ${(error as Error).message}. ` +
            `Original bytes were restored.`,
        );
      }
    }

    if (event.status === "error") {
      this.log.debug(
        `tool ${operation.tool} failed; ${operation.files.size} file(s) restored`,
      );
    }
  }

  private async restore(file: CapturedFile): Promise<void> {
    if (file.action === "delete") return;
    if (file.moveTo) {
      await this.restoreMoved(file);
      return;
    }

    const current = await readFileSafe(file.absolutePath);
    if (current === undefined) return; // tool removed it — nothing to restore

    // Tool did not touch the file: put the snapshot back so Git sees no diff.
    if (
      file.originalBytes &&
      file.swapBytes &&
      current.equals(file.swapBytes)
    ) {
      await atomicWrite(file.absolutePath, file.originalBytes);
      this.log.debug(
        `restored ${file.relativePath} unchanged (${ENCODING_LABELS[file.targetEncoding]})`,
      );
      return;
    }
    if (
      file.originalBytes &&
      !file.swapBytes &&
      current.equals(file.originalBytes)
    )
      return;

    const restored = await this.renderTarget(file, current);
    if (!restored) return;
    if (restored.equals(current)) return;

    await atomicWrite(file.absolutePath, restored);

    const written = await readFileSafe(file.absolutePath);
    if (!written || !written.equals(restored)) {
      throw new Error(
        "verification after write failed: bytes on disk differ from the intended encoding",
      );
    }

    this.log.info(
      `${file.relativePath} — ${ENCODING_LABELS[file.targetEncoding]} preserved` +
        (this.config.preserveLineEndings
          ? ` · ${LINE_ENDING_LABELS[file.metadata.lineEnding]} preserved`
          : "") +
        (this.config.preserveBom && file.metadata.bom
          ? " · BOM preserved"
          : ""),
    );
  }

  /** A rename carries the encoding with the content. */
  private async restoreMoved(file: CapturedFile): Promise<void> {
    const destination = file.moveTo!;
    const current = await readFileSafe(destination);
    if (current === undefined) return;
    if (file.originalBytes && current.equals(file.originalBytes)) {
      if (file.swapBytes) await atomicWrite(destination, file.originalBytes);
      return;
    }

    const moved: CapturedFile = {
      ...file,
      absolutePath: destination,
      swapBytes: undefined,
    };
    const restored = await this.renderTarget(moved, current);
    if (!restored || restored.equals(current)) return;
    await atomicWrite(destination, restored);
    this.log.debug(
      `moved file ${file.relativePath} → ${this.relativePath(destination)} kept its encoding`,
    );
  }

  /**
   * Build the byte sequence the file must have on disk: decoded text, original
   * line-ending convention, original BOM state, original encoding.
   */
  private async renderTarget(
    file: CapturedFile,
    current: Buffer,
  ): Promise<Buffer | undefined> {
    const target = file.targetEncoding;
    let text = this.decodeCurrent(file, current);
    if (text === undefined) return undefined;

    if (!canEncode(text, target)) {
      const message =
        `Encoding Guard detected characters that cannot be represented in ` +
        `${ENCODING_LABELS[target]}:\n${describeUnencodable(text, target)}`;

      if (
        this.config.unsupportedCharacters === "block" &&
        this.config.mode === "preserve"
      ) {
        throw new Error(
          `${message}\n\nFile:\n${file.relativePath}\n\nThe write was rejected; no encoding loss was allowed.`,
        );
      }
      this.log.warn(`${message}\n(file left as the tool wrote it)`);
      return undefined;
    }

    if (this.config.preserveLineEndings && !file.metadata.mixedLineEndings) {
      if (!hasLineEnding(text, file.metadata.lineEnding)) {
        text = applyLineEnding(text, file.metadata.lineEnding);
        this.log.warn(
          `${file.relativePath}: line endings normalised back to ${LINE_ENDING_LABELS[file.metadata.lineEnding]}`,
        );
      }
    } else if (
      file.metadata.mixedLineEndings &&
      !hasLineEnding(text, file.metadata.lineEnding)
    ) {
      this.log.warn(
        `${file.relativePath} mixes line endings; leaving the tool output unchanged ` +
          `to avoid normalising unrelated lines`,
      );
    }

    let bytes = encodeText(text, target);
    if (this.config.preserveBom && file.metadata.bom)
      bytes = Buffer.concat([UTF8_BOM, bytes]);
    return bytes;
  }

  /** Tools write UTF-8; fall back to the target encoding if the bytes are not valid UTF-8. */
  private decodeCurrent(
    file: CapturedFile,
    current: Buffer,
  ): string | undefined {
    const withoutBom = stripBom(current);
    try {
      return decodeStrict(withoutBom, "utf8");
    } catch {
      try {
        return decodeStrict(withoutBom, file.targetEncoding);
      } catch (error) {
        this.log.warn(
          `cannot decode ${file.relativePath}: ${(error as Error).message}`,
        );
        return undefined;
      }
    }
  }

  private async rollback(file: CapturedFile): Promise<void> {
    if (!file.originalBytes) return;
    try {
      await atomicWrite(file.absolutePath, file.originalBytes);
    } catch (error) {
      this.log.error(
        `rollback of ${file.relativePath} failed: ${(error as Error).message}`,
      );
    }
  }
}

function decodeStrict(bytes: Buffer, encoding: SupportedEncoding): string {
  if (encoding === "utf8") {
    // Keep U+FFFD out of the pipeline: a replacement character means the bytes
    // are not UTF-8 and re-encoding them would silently corrupt the file.
    return new TextDecoder("utf-8", { fatal: true }).decode(stripBom(bytes));
  }
  return decodeBytes(bytes, encoding);
}
