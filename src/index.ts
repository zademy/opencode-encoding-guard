import type { Plugin } from "@opencode/plugin";
import { loadConfig, type GuardConfig } from "./config.js";
import { loadProjectConfig } from "./core/project.js";
import {
  EncodingGuard,
  createLogger,
  type GuardEvent,
  type GuardResultEvent,
} from "./opencode/guard.js";
import { inspectPath, scanProject } from "./opencode/tools.js";

export {
  loadConfig,
  DEFAULT_CONFIG,
  mergeConfig,
  type GuardConfig,
} from "./config.js";
export { EncodingGuard, GuardBlockedError } from "./opencode/guard.js";
export {
  parsePatch,
  summariseImpact,
  type PatchImpact,
  type PatchFile,
} from "./opencode/patch-paths.js";
export { inspectPath, scanProject } from "./opencode/tools.js";
export * from "./core/types.js";
export {
  detectEncoding,
  detectBom,
  isBinary,
  analyzeBytes,
} from "./core/detect.js";
export {
  decodeBytes,
  encodeText,
  canEncode,
  unencodableCharacters,
} from "./core/codec.js";
export { detectLineEndings, applyLineEnding } from "./core/line-endings.js";
export {
  parseEclipsePreferences,
  resolveEclipseEncoding,
} from "./core/eclipse.js";
export { parseEditorConfig, resolveEditorConfig } from "./core/editorconfig.js";

const TOOL_INSPECT = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File to inspect, relative to the project root.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const TOOL_SCAN = {
  type: "object",
  properties: {
    limit: {
      type: "number",
      description: "Maximum number of files to scan (default 2000).",
    },
  },
  additionalProperties: false,
} as const;

/**
 * OpenCode V2 plugin entry point.
 *
 * `Plugin.define()` is an identity helper in the V2 SDK; typing the object as
 * `Plugin.Plugin` yields exactly the same result while keeping the SDK import
 * type-only, so the built plugin never has to resolve `@opencode/plugin` at
 * runtime.
 */
export const EncodingGuardPlugin: Plugin.Plugin = {
  id: "opencode-encoding-guard",

  async setup(ctx) {
    const root = ctx.location.project.directory || ctx.location.directory;
    const config: GuardConfig = loadConfig(
      root,
      ctx.options as Record<string, unknown> | undefined,
    );
    const log = createLogger(config.debug);

    if (!config.enabled) {
      log.debug("disabled by configuration");
      return;
    }

    const guard = new EncodingGuard({ root, config, logger: log });
    // Warm the Eclipse/.editorconfig cache once so the first edit is not slower
    // than the rest. A failure here must not stop the plugin from loading.
    await loadProjectConfig(root, config).catch(() => undefined);

    log.debug(
      `protecting ${root} (mode=${config.mode}, block=${config.unsupportedCharacters})`,
    );

    await ctx.tool.hook("execute.before", async (event) => {
      const guardEvent: GuardEvent = {
        tool: event.tool,
        id: event.id,
        input: event.input,
      };
      await guard.before(guardEvent);
    });

    await ctx.tool.hook("execute.after", async (event) => {
      const guardEvent: GuardResultEvent = {
        tool: event.tool,
        id: event.id,
        input: event.input,
        status: event.status,
      };
      await guard.after(guardEvent);
    });

    await ctx.tool.transform(async (editor) => {
      editor.add({
        name: "encoding_inspect",
        description:
          "Report the encoding, BOM, line endings and round-trip status of a file without modifying it. " +
          "Use it before editing legacy (non-UTF-8) files.",
        input: TOOL_INSPECT as never,
        execute: async (input: unknown) => {
          const report = await inspectPath(
            root,
            (input ?? {}) as { path?: unknown },
            config,
          ).catch(
            (error: unknown) =>
              `encoding_inspect failed: ${(error as Error).message}`,
          );
          return { title: "encoding_inspect", content: report, metadata: {} };
        },
      });

      editor.add({
        name: "encoding_scan",
        description:
          "Summarise the encodings used across the project and report files that are at risk of corruption. Read-only.",
        input: TOOL_SCAN as never,
        execute: async (input: unknown) => {
          const { report } = await scanProject(
            root,
            (input ?? {}) as { limit?: unknown },
            config,
          ).catch((error: unknown) => ({
            report: `encoding_scan failed: ${(error as Error).message}`,
            result: {
              counts: {},
              total: 0,
              mixed: false,
              eclipseDetected: false,
              atRisk: [],
              truncated: false,
            },
          }));
          return { title: "encoding_scan", content: report, metadata: {} };
        },
      });
    });
  },
};

export default EncodingGuardPlugin;
