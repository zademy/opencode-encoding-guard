import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { mergeConfig, DEFAULT_CONFIG } from "../src/config.js";
import { decodeBytes } from "../src/core/codec.js";
import { EncodingGuard, type Logger } from "../src/opencode/guard.js";
import {
  cleanup,
  createProject,
  ISO_8859_1_BYTES,
  writeBytes,
} from "./helpers.js";

const run = promisify(execFile);

/**
 * Acceptance test from the spec: a real Git repository, a real ISO-8859-1 +
 * CRLF Java file, one ASCII line changed through the same guard path the
 * OpenCode hook uses. Git must show a one-line diff — not a whole-file rewrite.
 */
describe("git diff acceptance", () => {
  test("one line changed in a committed ISO-8859-1 CRLF file stays a one line diff", async () => {
    const root = await createProject("encoding-guard-git-");
    try {
      await run("git", ["init", "-q"], { cwd: root });
      await run("git", ["config", "user.email", "guard@example.com"], {
        cwd: root,
      });
      await run("git", ["config", "user.name", "Encoding Guard"], {
        cwd: root,
      });

      const path = join(root, "Servicio.java");
      await writeBytes(path, ISO_8859_1_BYTES);
      await run("git", ["add", "-A"], { cwd: root });
      await run("git", ["commit", "-qm", "initial"], { cwd: root });

      const guard = new EncodingGuard({
        root,
        config: mergeConfig(DEFAULT_CONFIG),
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } satisfies Logger,
      });

      const input = {
        filePath: path,
        oldString: "int segunda = 2;",
        newString: "int tercera = 3;",
      };
      await guard.before({ tool: "edit", id: "git-1", input });

      // Exactly what opencode does: read UTF-8, apply, write UTF-8.
      const updated = (await readFile(path, "utf8")).replace(
        "int segunda = 2;",
        "int tercera = 3;",
      );
      await writeBytes(path, Buffer.from(updated, "utf8"));

      await guard.after({
        tool: "edit",
        id: "git-1",
        input,
        status: "completed",
      });

      const { stdout: numstat } = await run("git", ["diff", "--numstat"], {
        cwd: root,
      });
      expect(numstat.trim()).toBe("1\t1\tServicio.java");

      const { stdout: diff } = await run("git", ["diff"], { cwd: root });
      expect(diff).toContain("-int segunda = 2;");
      expect(diff).toContain("+int tercera = 3;");
      // Unrelated accented lines must not appear in the diff at all.
      expect(diff).not.toContain("Información");
      expect(diff).not.toContain("Contraseña");

      const final = await readFile(path);
      expect(final.includes(0x0d)).toBe(true); // CRLF kept
      expect(final.includes(0xf3)).toBe(true); // ó kept as ISO-8859-1
      expect(final.includes(0xef)).toBe(false); // never converted to UTF-8

      const text = decodeBytes(final, "iso-8859-1");
      expect(text).toContain("Información del trámite");
      expect(text).not.toContain("InformaciÃ³n");

      const { stdout: fileOut } = await run("file", ["Servicio.java"], {
        cwd: root,
      });
      expect(fileOut).toContain("ISO-8859");
    } finally {
      await cleanup(root);
    }
  });
});
