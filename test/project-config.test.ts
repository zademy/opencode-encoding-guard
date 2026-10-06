import { describe, expect, test } from "bun:test";
import {
  parseEclipsePreferences,
  resolveEclipseEncoding,
} from "../src/core/eclipse.js";
import {
  parseEditorConfig,
  resolveEditorConfig,
} from "../src/core/editorconfig.js";
import { matchesEditorConfigGlob, matchesGlob } from "../src/core/glob.js";
import { ECLIPSE_PREFS_ISO } from "./helpers.js";

describe("eclipse preferences", () => {
  test("parses project default and resource entries", () => {
    const preferences = parseEclipsePreferences(ECLIPSE_PREFS_ISO);
    expect(preferences.projectDefault).toBe("utf8");
    expect(preferences.resources).toHaveLength(3);
  });

  test("file entry wins over folder entry", () => {
    const preferences = parseEclipsePreferences(ECLIPSE_PREFS_ISO);
    const resolved = resolveEclipseEncoding(
      preferences,
      "legacy",
      "legacy/src/main/webapp/legacy-note.txt",
    );
    expect(resolved?.encoding).toBe("utf8");
  });

  test("folder entry wins over project entry", () => {
    const preferences = parseEclipsePreferences(ECLIPSE_PREFS_ISO);
    const resolved = resolveEclipseEncoding(
      preferences,
      "legacy",
      "legacy/src/main/webapp/x.jsp",
    );
    expect(resolved?.encoding).toBe("windows-1252");
  });

  test("project entry is used for deeper paths", () => {
    const preferences = parseEclipsePreferences(ECLIPSE_PREFS_ISO);
    expect(
      resolveEclipseEncoding(preferences, "legacy", "legacy/src/A.java")
        ?.encoding,
    ).toBe("iso-8859-1");
  });

  test("project default is the last resort", () => {
    const preferences = parseEclipsePreferences(ECLIPSE_PREFS_ISO);
    expect(
      resolveEclipseEncoding(preferences, "legacy", "other/B.java")?.encoding,
    ).toBe("utf8");
  });

  test("accepts bare charset values and modern Eclipse spellings", () => {
    const preferences = parseEclipsePreferences(
      [
        "eclipse.preferences.core.defaultEncoding=windows-1252",
        "/proj/src/legacy.txt=ISO8859_1",
        "/proj/src/modern.txt=UTF-8",
        "/proj/ignored.txt=Shift_JIS",
      ].join("\n"),
    );
    expect(preferences.projectDefault).toBe("windows-1252");
    expect(
      resolveEclipseEncoding(preferences, "proj", "proj/src/legacy.txt")
        ?.encoding,
    ).toBe("iso-8859-1");
    // Unsupported charsets are ignored instead of guessed.
    expect(
      preferences.resources.some((entry) => entry.path === "proj/ignored.txt"),
    ).toBe(false);
  });

  test("malformed preferences do not throw", () => {
    expect(() =>
      parseEclipsePreferences("=broken\nno-equals-sign\n\n#comment"),
    ).not.toThrow();
    expect(parseEclipsePreferences("=broken").projectDefault).toBeUndefined();
  });
});

describe("editorconfig", () => {
  test("parses sections and charset", () => {
    const sections = parseEditorConfig(
      [
        "root = true",
        "",
        "[*.{java,jsp}]",
        "charset = latin1",
        "end_of_line = crlf",
        "[*.properties]",
        "charset = utf-8",
      ].join("\n"),
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]?.properties).toEqual({
      charset: "iso-8859-1",
      endOfLine: "CRLF",
    });
  });

  test("resolves the nearest matching section", () => {
    const entries = [
      {
        baseDirectory: "",
        sections: [
          { glob: "*.java", properties: { charset: "utf8" as const } },
        ],
      },
      {
        baseDirectory: "legacy",
        sections: [
          { glob: "*.java", properties: { charset: "iso-8859-1" as const } },
        ],
      },
    ];
    expect(resolveEditorConfig(entries, "legacy/src/A.java").charset).toBe(
      "iso-8859-1",
    );
    expect(resolveEditorConfig(entries, "modern/src/A.java").charset).toBe(
      "utf8",
    );
  });

  test("section paths are anchored when the glob contains a slash", () => {
    const entries = [
      {
        baseDirectory: "",
        sections: [
          {
            glob: "src/**/*.jsp",
            properties: { charset: "iso-8859-1" as const },
          },
        ],
      },
    ];
    expect(resolveEditorConfig(entries, "src/web/a.jsp").charset).toBe(
      "iso-8859-1",
    );
    expect(
      resolveEditorConfig(entries, "other/web/a.jsp").charset,
    ).toBeUndefined();
  });
});

describe("glob matching", () => {
  test("matches nested and brace globs", () => {
    expect(matchesGlob("**/*.java", "src/main/java/A.java")).toBe(true);
    expect(matchesGlob("*.java", "src/main/java/A.java")).toBe(true);
    expect(matchesGlob("src/*.java", "src/A.java")).toBe(true);
    expect(matchesGlob("src/*.java", "src/nested/A.java")).toBe(false);
    expect(matchesEditorConfigGlob("*.{java,jsp}", "src/A.jsp")).toBe(true);
    expect(matchesEditorConfigGlob("*.{java,jsp}", "src/A.txt")).toBe(false);
  });
});
