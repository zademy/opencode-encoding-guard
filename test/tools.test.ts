import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { UTF8_BOM } from "../src/core/codec.js";
import { inspectPath, scanProject } from "../src/opencode/tools.js";
import {
  cleanup,
  createProject,
  ECLIPSE_PREFS_ISO,
  ISO_8859_1_BYTES,
  writeBytes,
  writeText,
} from "./helpers.js";

let root: string;

beforeEach(async () => {
  root = await createProject();
});

afterEach(async () => {
  await cleanup(root);
});

describe("encoding_inspect", () => {
  test("reports encoding, source, BOM, line endings and round-trip", async () => {
    await writeBytes(join(root, "Servicio.java"), ISO_8859_1_BYTES);

    const report = await inspectPath(
      root,
      { path: "Servicio.java" },
      DEFAULT_CONFIG,
    );
    expect(report).toContain("File:\nServicio.java");
    expect(report).toContain("Encoding:\nISO-8859-1");
    expect(report).toContain("Source:\nByte analysis");
    expect(report).toContain("BOM:\nNo");
    expect(report).toContain("Line endings:\nCRLF");
    expect(report).toContain("Round-trip:\nOK");
    expect(report).toContain("Protection:\nActive");
  });

  test("names Eclipse as the source when the project declares it", async () => {
    await mkdir(join(root, "legacy", ".settings"), { recursive: true });
    await writeText(
      join(root, "legacy", ".settings", "org.eclipse.core.resources.prefs"),
      ECLIPSE_PREFS_ISO,
    );
    await writeBytes(join(root, "legacy", "src", "A.java"), ISO_8859_1_BYTES);

    const report = await inspectPath(
      root,
      { path: "legacy/src/A.java" },
      DEFAULT_CONFIG,
    );
    expect(report).toContain("Encoding:\nISO-8859-1");
    expect(report).toContain("Source:\nEclipse project preference");
  });

  test("detects a UTF-8 BOM", async () => {
    await writeBytes(
      join(root, "Modern.java"),
      Buffer.concat([UTF8_BOM, Buffer.from("const a = 1;\n")]),
    );
    const report = await inspectPath(
      root,
      { path: "Modern.java" },
      DEFAULT_CONFIG,
    );
    expect(report).toContain("Encoding:\nUTF-8");
    expect(report).toContain("BOM:\nYes (UTF-8)");
  });

  test("is read-only", async () => {
    await writeBytes(join(root, "Servicio.java"), ISO_8859_1_BYTES);
    await inspectPath(root, { path: "Servicio.java" }, DEFAULT_CONFIG);
    expect((await import("node:fs/promises")).readFile).toBeDefined();
    const { readFile } = await import("node:fs/promises");
    expect(
      (await readFile(join(root, "Servicio.java"))).equals(ISO_8859_1_BYTES),
    ).toBe(true);
  });

  test("refuses paths outside the project root", async () => {
    const report = await inspectPath(
      root,
      { path: "../../etc/passwd" },
      DEFAULT_CONFIG,
    );
    expect(report).toContain("outside the project root");
  });

  test("explains missing input and missing files", async () => {
    expect(await inspectPath(root, {}, DEFAULT_CONFIG)).toContain(
      "requires a `path`",
    );
    expect(
      await inspectPath(root, { path: "nope.java" }, DEFAULT_CONFIG),
    ).toContain("Not found");
  });

  test("reports oversized files as unprotected", async () => {
    await writeBytes(join(root, "Big.java"), ISO_8859_1_BYTES);
    const report = await inspectPath(
      root,
      { path: "Big.java" },
      mergeConfig(DEFAULT_CONFIG, { maxFileBytes: 4 }),
    );
    expect(report).toContain("Skipped");
  });
});

describe("encoding_scan", () => {
  test("summarises the encodings present in the project", async () => {
    await writeBytes(join(root, "a", "Legacy.java"), ISO_8859_1_BYTES);
    await writeText(join(root, "a", "Modern.java"), "// ñ\nconst a = 1;\n");
    await writeBytes(
      join(root, "a", "Bom.java"),
      Buffer.concat([UTF8_BOM, Buffer.from("x = 1\n")]),
    );
    await writeText(join(root, "a", "Cp1252.sql"), "// € 10\n", "windows-1252");
    await writeText(join(root, "a", "Plain.txt"), "plain\n");

    const { report, result } = await scanProject(root, {}, DEFAULT_CONFIG);
    expect(result.counts["ISO-8859-1"]).toBe(1);
    expect(result.counts["UTF-8"]).toBe(1);
    expect(result.counts["UTF-8 BOM"]).toBe(1);
    expect(result.counts["Windows-1252"]).toBe(1);
    expect(result.counts["ASCII"]).toBe(1);
    expect(result.mixed).toBe(true);
    expect(report).toContain("Encoding Guard — Project Report");
    expect(report).toContain("Mixed-encoding repository detected.\nYes");
    expect(report).toContain("Eclipse encoding configuration:\nNot detected");
  });

  test("detects the Eclipse configuration and skips ignored directories", async () => {
    await mkdir(join(root, "legacy", ".settings"), { recursive: true });
    await writeText(
      join(root, "legacy", ".settings", "org.eclipse.core.resources.prefs"),
      ECLIPSE_PREFS_ISO,
    );
    await writeBytes(join(root, "legacy", "A.java"), ISO_8859_1_BYTES);
    await writeText(
      join(root, "target", "Generated.java"),
      "// build output\n",
    );

    const { result } = await scanProject(root, {}, DEFAULT_CONFIG);
    expect(result.eclipseDetected).toBe(true);
    // `target` is ignored; the two remaining files are the legacy source and
    // the Eclipse preferences file itself.
    expect(result.total).toBe(2);
  });

  test("honours the scan limit", async () => {
    for (let index = 0; index < 5; index++) {
      await writeText(join(root, `f${index}.txt`), `file ${index}\n`);
    }
    const { result } = await scanProject(root, { limit: 3 }, DEFAULT_CONFIG);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
  });

  test("never writes to the project", async () => {
    await writeBytes(join(root, "A.java"), ISO_8859_1_BYTES);
    const before = await (
      await import("node:fs/promises")
    ).readFile(join(root, "A.java"));
    await scanProject(root, {}, DEFAULT_CONFIG);
    const after = await (
      await import("node:fs/promises")
    ).readFile(join(root, "A.java"));
    expect(after.equals(before)).toBe(true);
  });
});
