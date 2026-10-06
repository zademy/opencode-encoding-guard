import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeText } from "../src/core/codec.js";
import type { SupportedEncoding } from "../src/core/types.js";

export async function createProject(
  prefix = "encoding-guard-",
): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function writeBytes(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export async function writeText(
  path: string,
  text: string,
  encoding: SupportedEncoding = "utf8",
): Promise<Buffer> {
  const bytes = encodeText(text, encoding);
  await writeBytes(path, bytes);
  return bytes;
}

export async function cleanup(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * Literal byte fixture — `Información del trámite` in ISO-8859-1.
 * Written by hand (not produced by the library under test) so the test fails if
 * the encoder ever changes how it maps `ó`/`á`.
 */
export const ISO_8859_1_BYTES = Buffer.from([
  0x2f, 0x2f, 0x20, 0x49, 0x6e, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x63, 0x69, 0xf3,
  0x6e, 0x20, 0x64, 0x65, 0x6c, 0x20, 0x74, 0x72, 0xe1, 0x6d, 0x69, 0x74, 0x65,
  0x0d, 0x0a, 0x69, 0x6e, 0x74, 0x20, 0x73, 0x65, 0x67, 0x75, 0x6e, 0x64, 0x61,
  0x20, 0x3d, 0x20, 0x32, 0x3b, 0x0d, 0x0a, 0x2f, 0x2f, 0x20, 0x43, 0x6f, 0x6e,
  0x74, 0x72, 0x61, 0x73, 0x65, 0xf1, 0x61, 0x0d, 0x0a,
]);

/** Same text, CRLF line endings, no BOM, ISO-8859-1. */
export const ISO_8859_1_TEXT =
  "// Información del trámite\r\nint segunda = 2;\r\n// Contraseña\r\n";

export const ECLIPSE_PREFS_ISO = `#Wed Oct 08 09:12:00 CEST 2026
eclipse.preferences.core.defaultEncoding=UTF-8
/legacy=encode.ISO-8859-1
/legacy/src/main/webapp=encode.windows-1252
/legacy/src/main/webapp/legacy-note.txt=UTF-8
`;
