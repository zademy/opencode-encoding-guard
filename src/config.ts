import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSupportedEncoding,
  type LineEnding,
  type SupportedEncoding,
} from "./core/types.js";

export type GuardMode = "preserve" | "warn";
export type UnsupportedPolicy = "block" | "warn" | "allow-lossy";

export interface EncodingRule {
  glob: string;
  /** `preserve` = detect and keep; any other value forces the encoding. */
  encoding: "preserve" | SupportedEncoding;
  lineEnding?: LineEnding;
}

export interface GuardConfig {
  enabled: boolean;
  mode: GuardMode;
  /** Encoding used when no rule, Eclipse setting, .editorconfig or byte evidence exists. */
  fallbackEncoding: SupportedEncoding;
  /** Encoding for files that do not exist yet. `inherit` = resolve from project config. */
  newFileEncoding: "inherit" | SupportedEncoding;
  preserveLineEndings: boolean;
  preserveBom: boolean;
  unsupportedCharacters: UnsupportedPolicy;
  eclipse: { enabled: boolean };
  editorconfig: { enabled: boolean };
  rules: EncodingRule[];
  /** Files above this size are reported and skipped instead of buffered. */
  maxFileBytes: number;
  /** How deep to look for Eclipse projects / .editorconfig files. */
  maxConfigScanDepth: number;
  debug: boolean;
  ignore: string[];
}

export const CONFIG_FILE_NAMES = [
  ".encoding-guard.json",
  ".opencode-encoding-guard.json",
];

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  mode: "preserve",
  fallbackEncoding: "utf8",
  newFileEncoding: "inherit",
  preserveLineEndings: true,
  preserveBom: true,
  unsupportedCharacters: "block",
  eclipse: { enabled: true },
  editorconfig: { enabled: true },
  rules: [],
  maxFileBytes: 8 * 1024 * 1024,
  maxConfigScanDepth: 4,
  debug: false,
  ignore: [
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    "out",
    ".venv",
    "__pycache__",
  ],
};

export function loadConfig(
  root: string,
  options?: Record<string, unknown>,
): GuardConfig {
  const fileConfig = readConfigFile(root);
  return mergeConfig(DEFAULT_CONFIG, fileConfig, options ?? {});
}

function readConfigFile(root: string): Record<string, unknown> {
  for (const name of CONFIG_FILE_NAMES) {
    try {
      const content = readFileSync(join(root, name), "utf8");
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or malformed config must never break the plugin.
    }
  }
  return {};
}

export function mergeConfig(
  base: GuardConfig,
  ...overrides: Array<Record<string, unknown> | undefined>
): GuardConfig {
  const config: GuardConfig = {
    ...base,
    eclipse: { ...base.eclipse },
    editorconfig: { ...base.editorconfig },
  };

  for (const override of overrides) {
    if (!override) continue;

    if (typeof override.enabled === "boolean")
      config.enabled = override.enabled;
    if (override.mode === "preserve" || override.mode === "warn")
      config.mode = override.mode;
    if (isSupportedEncoding(override.fallbackEncoding))
      config.fallbackEncoding = override.fallbackEncoding;
    if (
      override.newFileEncoding === "inherit" ||
      isSupportedEncoding(override.newFileEncoding)
    ) {
      config.newFileEncoding = override.newFileEncoding;
    }
    if (typeof override.preserveLineEndings === "boolean") {
      config.preserveLineEndings = override.preserveLineEndings;
    }
    if (typeof override.preserveBom === "boolean")
      config.preserveBom = override.preserveBom;
    if (
      override.unsupportedCharacters === "block" ||
      override.unsupportedCharacters === "warn" ||
      override.unsupportedCharacters === "allow-lossy"
    ) {
      config.unsupportedCharacters = override.unsupportedCharacters;
    }
    if (
      typeof override.maxFileBytes === "number" &&
      override.maxFileBytes > 0
    ) {
      config.maxFileBytes = override.maxFileBytes;
    }
    if (
      typeof override.maxConfigScanDepth === "number" &&
      override.maxConfigScanDepth >= 0
    ) {
      config.maxConfigScanDepth = override.maxConfigScanDepth;
    }
    if (typeof override.debug === "boolean") config.debug = override.debug;

    const eclipse = override.eclipse;
    if (
      eclipse &&
      typeof eclipse === "object" &&
      typeof (eclipse as { enabled?: unknown }).enabled === "boolean"
    ) {
      config.eclipse.enabled = (eclipse as { enabled: boolean }).enabled;
    }
    const editorconfig = override.editorconfig;
    if (
      editorconfig &&
      typeof editorconfig === "object" &&
      typeof (editorconfig as { enabled?: unknown }).enabled === "boolean"
    ) {
      config.editorconfig.enabled = (
        editorconfig as { enabled: boolean }
      ).enabled;
    }
    if (Array.isArray(override.ignore)) {
      config.ignore = override.ignore.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
    if (Array.isArray(override.rules)) {
      config.rules = override.rules
        .map(parseRule)
        .filter((rule): rule is EncodingRule => rule !== undefined);
    }
  }

  return config;
}

function parseRule(value: unknown): EncodingRule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rule = value as {
    glob?: unknown;
    encoding?: unknown;
    lineEnding?: unknown;
  };
  if (typeof rule.glob !== "string" || rule.glob.length === 0) return undefined;

  let encoding: EncodingRule["encoding"] = "preserve";
  if (isSupportedEncoding(rule.encoding)) encoding = rule.encoding;

  const lineEnding =
    rule.lineEnding === "LF" ||
    rule.lineEnding === "CRLF" ||
    rule.lineEnding === "CR"
      ? rule.lineEnding
      : undefined;

  return lineEnding
    ? { glob: rule.glob, encoding, lineEnding }
    : { glob: rule.glob, encoding };
}

/** Encoding + line-ending policy for files that do not exist yet. */
export function newFilePolicy(config: GuardConfig): {
  encoding: SupportedEncoding | undefined;
  lineEnding: LineEnding | undefined;
} {
  return {
    encoding:
      config.newFileEncoding === "inherit" ? undefined : config.newFileEncoding,
    lineEnding: undefined,
  };
}
