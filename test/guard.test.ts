import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfig,
  type GuardConfig,
} from "../src/config.js";
import { decodeBytes, encodeText, UTF8_BOM } from "../src/core/codec.js";
import { EncodingGuard, type Logger } from "../src/opencode/guard.js";
import {
  cleanup,
  createProject,
  ISO_8859_1_BYTES,
  ISO_8859_1_TEXT,
  writeBytes,
  writeText,
} from "./helpers.js";

/**
 * Simulates what OpenCode actually does with a file, verified empirically
 * against opencode 2.0.24: read the file as UTF-8, apply the change, write it
 * back as UTF-8. On a legacy file this is exactly where U+FFFD is born.
 */
async function toolRead(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function toolWrite(path: string, text: string): Promise<void> {
  await writeFile(path, text, "utf8");
}

let root: string;
let guard: EncodingGuard;
let config: GuardConfig;
let logs: string[];

const silentLogger: Logger = {
  debug: () => {},
  info: (message) => logs.push(`info:${message}`),
  warn: (message) => logs.push(`warn:${message}`),
  error: (message) => logs.push(`error:${message}`),
};

beforeEach(async () => {
  root = await createProject();
  logs = [];
  config = mergeConfig(DEFAULT_CONFIG, { debug: false });
  guard = new EncodingGuard({ root, config, logger: silentLogger });
});

afterEach(async () => {
  await cleanup(root);
});

describe("legacy ISO-8859-1 file", () => {
  test("unrelated edit keeps the encoding, the bytes and CRLF", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const input = {
      filePath: path,
      oldString: "int segunda = 2;",
      newString: "int tercera = 3;",
    };
    await guard.before({ tool: "edit", id: "call-1", input });

    const updated = (await toolRead(path)).replace(
      "int segunda = 2;",
      "int tercera = 3;",
    );
    await toolWrite(path, updated);
    await guard.after({
      tool: "edit",
      id: "call-1",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(final.includes(0xf3)).toBe(true); // ó survived as a single ISO-8859-1 byte
    expect(final.includes(0xef)).toBe(false); // not converted to UTF-8
    expect(final.includes(0xbf)).toBe(false);
    expect(final.includes(Buffer.from("�"))).toBe(false); // no U+FFFD anywhere
    expect(final.includes(0x0d)).toBe(true); // CRLF preserved

    const text = decodeBytes(final, "iso-8859-1");
    expect(text).toContain("Información del trámite");
    expect(text).toContain("Contraseña");
    expect(text).toContain("int tercera = 3;");
    expect(text).not.toContain("segunda");
  });

  test("no-op edit leaves the file byte-identical", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const input = { filePath: path, oldString: "nothing", newString: "here" };
    await guard.before({ tool: "edit", id: "call-noop", input });
    await guard.after({
      tool: "edit",
      id: "call-noop",
      input,
      status: "completed",
    });

    expect((await readFile(path)).equals(ISO_8859_1_BYTES)).toBe(true);
  });

  test("unsupported character blocks the write before anything is touched", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const input = {
      filePath: path,
      oldString: "int segunda = 2;",
      newString: "✅ Operación terminada",
    };

    await expect(
      guard.before({ tool: "edit", id: "call-block", input }),
    ).rejects.toThrow(/U\+2705/);

    // The file was never staged or modified.
    expect((await readFile(path)).equals(ISO_8859_1_BYTES)).toBe(true);
  });

  test("write with unrepresentable content is blocked", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    await expect(
      guard.before({
        tool: "write",
        id: "call-write-block",
        input: { filePath: path, content: "// ✅\nOperación\n" },
      }),
    ).rejects.toThrow(/Encoding Guard blocked/);
    expect((await readFile(path)).equals(ISO_8859_1_BYTES)).toBe(true);
  });

  test("write of representable content keeps the legacy encoding", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const input = {
      filePath: path,
      content: "// Notificación\r\nint valor = 1;\r\n",
    };
    await guard.before({ tool: "write", id: "call-write", input });
    await toolWrite(path, input.content);
    await guard.after({
      tool: "write",
      id: "call-write",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(decodeBytes(final, "iso-8859-1")).toBe(input.content);
    expect(final.includes(0xf3)).toBe(true);
  });

  test("tool failure restores the original bytes", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const input = { filePath: path, oldString: "x", newString: "y" };
    await guard.before({ tool: "edit", id: "call-fail", input });
    await guard.after({
      tool: "edit",
      id: "call-fail",
      input,
      status: "error",
    });

    expect((await readFile(path)).equals(ISO_8859_1_BYTES)).toBe(true);
  });

  test("a non-representable result fails closed and rolls back", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    // Bypass the pre-flight check by staging first, then writing a character
    // the legacy encoding cannot hold.
    const input = { filePath: path, oldString: "x", newString: "y" };
    await guard.before({ tool: "edit", id: "call-lossy", input });
    await toolWrite(path, "// 🐧\nint segunda = 2;\n");
    await guard.after({
      tool: "edit",
      id: "call-lossy",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(final.equals(ISO_8859_1_BYTES)).toBe(true);
    expect(logs.some((line) => line.startsWith("error:"))).toBe(true);
  });

  test("line endings are restored when the tool normalises them", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const input = {
      filePath: path,
      oldString: "int segunda = 2;",
      newString: "int tercera = 3;",
    };
    await guard.before({ tool: "edit", id: "call-lf", input });
    // A tool that writes bare LF would produce a whole-file diff.
    await toolWrite(
      path,
      (await toolRead(path))
        .replace("int segunda = 2;", "int tercera = 3;")
        .replace(/\r\n/g, "\n"),
    );
    await guard.after({
      tool: "edit",
      id: "call-lf",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(final.includes(0x0d)).toBe(true);
    expect(decodeBytes(final, "iso-8859-1")).toContain("int tercera = 3;\r\n");
  });
});

describe("UTF-8 files", () => {
  test("UTF-8 file is left untouched apart from the intended edit", async () => {
    const path = join(root, "Modern.java");
    const original = "// Información del trámite\nint segunda = 2;\n";
    await writeText(path, original, "utf8");

    const input = {
      filePath: path,
      oldString: "int segunda = 2;",
      newString: "int tercera = 3;",
    };
    await guard.before({ tool: "edit", id: "utf8-1", input });
    await toolWrite(
      path,
      (await toolRead(path)).replace("int segunda = 2;", "int tercera = 3;"),
    );
    await guard.after({
      tool: "edit",
      id: "utf8-1",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(final.toString("utf8")).toBe(
      "// Información del trámite\nint tercera = 3;\n",
    );
    expect(final.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      false,
    );
  });

  test("UTF-8 BOM is preserved", async () => {
    const path = join(root, "Modern.java");
    await writeBytes(
      path,
      Buffer.concat([UTF8_BOM, encodeText("// ñandú\nint a = 1;\n", "utf8")]),
    );

    const input = {
      filePath: path,
      oldString: "int a = 1;",
      newString: "int a = 2;",
    };
    await guard.before({ tool: "edit", id: "bom-1", input });
    await toolWrite(
      path,
      (await toolRead(path)).replace("int a = 1;", "int a = 2;"),
    );
    await guard.after({
      tool: "edit",
      id: "bom-1",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(final.subarray(0, 3).equals(UTF8_BOM)).toBe(true);
    expect(final.toString("utf8")).toContain("ñandú");
  });

  test("a BOM is never introduced into a BOM-less file", async () => {
    const path = join(root, "Modern.java");
    await writeText(path, "// sin bom\nint a = 1;\n", "utf8");

    const input = {
      filePath: path,
      oldString: "int a = 1;",
      newString: "int a = 2;",
    };
    await guard.before({ tool: "edit", id: "nobom-1", input });
    await toolWrite(
      path,
      Buffer.concat([
        UTF8_BOM,
        Buffer.from("// sin bom\nint a = 2;\n", "utf8"),
      ] as never) as unknown as string,
    );
    await guard.after({
      tool: "edit",
      id: "nobom-1",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(final.subarray(0, 3).equals(UTF8_BOM)).toBe(false);
  });

  test("Windows-1252 keeps smart quotes through an edit", async () => {
    const path = join(root, "Legacy.sql");
    await writeText(path, "// “Texto” original\nSELECT 1;\n", "windows-1252");

    const input = {
      filePath: path,
      oldString: "SELECT 1;",
      newString: "SELECT 2;",
    };
    await guard.before({ tool: "edit", id: "cp1252-1", input });
    await toolWrite(
      path,
      (await toolRead(path)).replace("SELECT 1;", "SELECT 2;"),
    );
    await guard.after({
      tool: "edit",
      id: "cp1252-1",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(decodeBytes(final, "windows-1252")).toBe(
      "// “Texto” original\nSELECT 2;\n",
    );
    expect(final.includes(0x80)).toBe(false);
  });
});

describe("apply_patch", () => {
  test("a mixed UTF-8 + ISO-8859-1 patch preserves each file independently", async () => {
    const legacy = join(root, "src/Legacy.java");
    const modern = join(root, "web/Modern.js");
    await writeBytes(legacy, ISO_8859_1_BYTES);
    await writeText(modern, "// modern\nconst a = 1;\n", "utf8");

    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/Legacy.java",
      "@@",
      "-int segunda = 2;",
      "+int tercera = 3;",
      "*** Update File: web/Modern.js",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "*** End Patch",
    ].join("\n");

    const input = { patchText };
    await guard.before({ tool: "patch", id: "patch-1", input });

    // The tool now reads correct text from both files.
    const legacyText = await toolRead(legacy);
    expect(legacyText).toContain("Información del trámite");
    await toolWrite(
      legacy,
      legacyText.replace("int segunda = 2;", "int tercera = 3;"),
    );
    await toolWrite(
      modern,
      (await toolRead(modern)).replace("const a = 1;", "const a = 2;"),
    );
    await guard.after({
      tool: "patch",
      id: "patch-1",
      input,
      status: "completed",
    });

    const legacyFinal = await readFile(legacy);
    expect(legacyFinal.includes(0xf3)).toBe(true);
    expect(legacyFinal.includes(0xef)).toBe(false);
    expect(decodeBytes(legacyFinal, "iso-8859-1")).toContain(
      "int tercera = 3;",
    );

    const modernFinal = await readFile(modern);
    expect(modernFinal.toString("utf8")).toBe("// modern\nconst a = 2;\n");
  });

  test("add file uses the plugin default when nothing declares an encoding", async () => {
    const added = join(root, "src/Added.java");
    const deleted = join(root, "src/Old.java");
    await writeBytes(deleted, ISO_8859_1_BYTES);

    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/Added.java",
      "+// Operación añadida",
      "*** Delete File: src/Old.java",
      "*** End Patch",
    ].join("\n");
    const input = { patchText };
    await guard.before({ tool: "patch", id: "patch-2", input });

    await toolWrite(added, "// Operación añadida\n");
    // The tool deletes the file; the guard must not resurrect it.
    await rm(deleted);
    await guard.after({
      tool: "patch",
      id: "patch-2",
      input,
      status: "completed",
    });

    // No Eclipse/.editorconfig configuration exists, so a new file is UTF-8.
    expect((await readFile(added)).toString("utf8")).toBe(
      "// Operación añadida\n",
    );
    // The deleted legacy file must not be resurrected or rewritten.
    expect(existsSync(deleted)).toBe(false);
  });

  test("a new file inside an Eclipse legacy project is created as ISO-8859-1", async () => {
    await mkdir(join(root, "legacy", ".settings"), { recursive: true });
    await writeText(
      join(root, "legacy", ".settings", "org.eclipse.core.resources.prefs"),
      [
        "eclipse.preferences.core.defaultEncoding=UTF-8",
        "/legacy=encode.ISO-8859-1",
        "",
      ].join("\n"),
    );

    const added = join(root, "legacy", "src", "Added.java");
    await mkdir(join(root, "legacy", "src"), { recursive: true });
    const patchText = [
      "*** Begin Patch",
      "*** Add File: legacy/src/Added.java",
      "+// Operación añadida",
      "*** End Patch",
    ].join("\n");
    const input = { patchText };

    await guard.before({ tool: "patch", id: "patch-new", input });
    await toolWrite(added, "// Operación añadida\n");
    await guard.after({
      tool: "patch",
      id: "patch-new",
      input,
      status: "completed",
    });

    const addedFinal = await readFile(added);
    expect(decodeBytes(addedFinal, "iso-8859-1")).toBe(
      "// Operación añadida\n",
    );
    expect(addedFinal.includes(0xf3)).toBe(true);
    expect(addedFinal.includes(0xef)).toBe(false);
  });

  test("rename carries the encoding with the content", async () => {
    const from = join(root, "src/Old.java");
    const to = join(root, "src/New.java");
    await writeBytes(from, ISO_8859_1_BYTES);

    const input = {
      patchText: `*** Begin Patch\n*** Update File: src/Old.java\n*** Move to: src/New.java\n@@\n-int segunda = 2;\n+int segunda = 22;\n*** End Patch`,
    };
    await guard.before({ tool: "patch", id: "patch-3", input });

    const text = await toolRead(from);
    await toolWrite(
      from,
      text.replace("int segunda = 2;", "int segunda = 22;"),
    );
    await import("node:fs/promises").then(({ rename }) => rename(from, to));
    await guard.after({
      tool: "patch",
      id: "patch-3",
      input,
      status: "completed",
    });

    const final = await readFile(to);
    expect(decodeBytes(final, "iso-8859-1")).toContain("int segunda = 22;");
    expect(final.includes(0xf3)).toBe(true);
    expect(final.includes(0xef)).toBe(false);
  });
});

describe("concurrency and safety", () => {
  test("two overlapping operations do not share state", async () => {
    const first = join(root, "First.java");
    const second = join(root, "Second.java");
    await writeText(first, "int a = 1;\n", "iso-8859-1");
    await writeText(second, "// ñandú\nint b = 2;\n", "iso-8859-1");

    const inputA = {
      filePath: first,
      oldString: "int a = 1;",
      newString: "int a = 11;",
    };
    const inputB = {
      filePath: second,
      oldString: "int b = 2;",
      newString: "int b = 22;",
    };

    await guard.before({ tool: "edit", id: "op-a", input: inputA });
    await guard.before({ tool: "edit", id: "op-b", input: inputB });

    await toolWrite(
      first,
      (await toolRead(first)).replace("int a = 1;", "int a = 11;"),
    );
    await toolWrite(
      second,
      (await toolRead(second)).replace("int b = 2;", "int b = 22;"),
    );

    // Out-of-order completion must not restore the wrong snapshot.
    await guard.after({
      tool: "edit",
      id: "op-b",
      input: inputB,
      status: "completed",
    });
    await guard.after({
      tool: "edit",
      id: "op-a",
      input: inputA,
      status: "completed",
    });

    const firstFinal = await readFile(first);
    const secondFinal = await readFile(second);
    expect(decodeBytes(firstFinal, "iso-8859-1")).toBe("int a = 11;\n");
    expect(decodeBytes(secondFinal, "iso-8859-1")).toBe(
      "// ñandú\nint b = 22;\n",
    );
    expect(secondFinal.includes(0xf1)).toBe(true);
  });

  test("paths outside the project root are refused", async () => {
    const outside = join(root, "../outside.txt");
    await writeText(outside, "no tocar\n", "iso-8859-1");

    const input = { filePath: outside, oldString: "no", newString: "si" };
    await guard.before({ tool: "edit", id: "escape", input });
    await guard.after({
      tool: "edit",
      id: "escape",
      input,
      status: "completed",
    });

    expect(await readFile(outside, "utf8")).toBe("no tocar\n");
    expect(logs.some((line) => line.includes("outside the project root"))).toBe(
      true,
    );
  });

  test("non-mutating tools are ignored", async () => {
    await guard.before({
      tool: "read",
      id: "read-1",
      input: { filePath: join(root, "a.txt") },
    });
    await guard.after({
      tool: "read",
      id: "read-1",
      input: {},
      status: "completed",
    });
    expect(logs.length).toBe(0);
  });

  test("an unknown operation id is a no-op", async () => {
    await expect(
      guard.after({
        tool: "edit",
        id: "never-seen",
        input: {},
        status: "completed",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("configuration", () => {
  test("explicit rules take priority over the file bytes", async () => {
    const path = join(root, "Forced.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const forced = mergeConfig(DEFAULT_CONFIG, {
      rules: [{ glob: "**/*.java", encoding: "windows-1252" }],
    });
    const forcedGuard = new EncodingGuard({
      root,
      config: forced,
      logger: silentLogger,
    });
    const input = {
      filePath: path,
      oldString: "int segunda = 2;",
      newString: "int tercera = 3;",
    };
    await forcedGuard.before({ tool: "edit", id: "forced-1", input });
    await toolWrite(
      path,
      (await toolRead(path)).replace("int segunda = 2;", "int tercera = 3;"),
    );
    await forcedGuard.after({
      tool: "edit",
      id: "forced-1",
      input,
      status: "completed",
    });

    const final = await readFile(path);
    expect(decodeBytes(final, "windows-1252")).toContain(
      "Información del trámite",
    );
  });

  test("warn mode reports instead of blocking", async () => {
    const path = join(root, "Servicio.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const warnConfig = mergeConfig(DEFAULT_CONFIG, {
      unsupportedCharacters: "warn",
    });
    const warnGuard = new EncodingGuard({
      root,
      config: warnConfig,
      logger: silentLogger,
    });
    const input = { filePath: path, oldString: "a", newString: "✅" };

    await expect(
      warnGuard.before({ tool: "edit", id: "warn-1", input }),
    ).resolves.toBeUndefined();
    expect(logs.some((line) => line.startsWith("warn:"))).toBe(true);
  });

  test("config file overrides defaults", async () => {
    await writeText(
      join(root, ".encoding-guard.json"),
      JSON.stringify({ debug: true, maxFileBytes: 1024 }),
    );
    const loaded = loadConfig(root);
    expect(loaded.debug).toBe(true);
    expect(loaded.maxFileBytes).toBe(1024);
  });

  test("malformed config never breaks the plugin", async () => {
    await writeText(join(root, ".encoding-guard.json"), "{ not json");
    expect(loadConfig(root).enabled).toBe(true);
  });

  test("files above maxFileBytes are skipped with a warning", async () => {
    const path = join(root, "Big.java");
    await writeBytes(path, ISO_8859_1_BYTES);

    const smallLimit = mergeConfig(DEFAULT_CONFIG, { maxFileBytes: 4 });
    const limited = new EncodingGuard({
      root,
      config: smallLimit,
      logger: silentLogger,
    });
    const input = { filePath: path, oldString: "x", newString: "y" };
    await limited.before({ tool: "edit", id: "big-1", input });
    await toolWrite(
      path,
      (await toolRead(path)).replace("int segunda = 2;", "int tercera = 3;"),
    );
    await limited.after({
      tool: "edit",
      id: "big-1",
      input,
      status: "completed",
    });

    expect(logs.some((line) => line.includes("maxFileBytes"))).toBe(true);
    // Unprotected: the guard did not stage, so the tool wrote plain UTF-8.
    expect((await readFile(path)).includes(0xef)).toBe(true);
  });

  test("ISO_8859_1_TEXT fixture stays in sync with the literal bytes", () => {
    expect(decodeBytes(ISO_8859_1_BYTES, "iso-8859-1")).toBe(ISO_8859_1_TEXT);
  });
});
