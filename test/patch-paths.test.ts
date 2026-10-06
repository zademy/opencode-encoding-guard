import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  isInsideRoot,
  parsePatch,
  PatchParseError,
  summariseImpact,
} from "../src/opencode/patch-paths.js";
import {
  extractMutationTargets,
  isMutatingTool,
} from "../src/opencode/paths.js";

const ROOT = "/projects/legacy";

describe("apply_patch path parsing", () => {
  test("parses add, update, move and delete in one patch", () => {
    const files = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: src/New.java",
        "+package com.example;",
        "+class New {}",
        "*** Update File: src/A.java",
        "*** Move to: src/Renamed.java",
        "@@ class A",
        "-int a = 1;",
        "+int a = 2;",
        "*** Delete File: src/Old.java",
        "*** End Patch",
      ].join("\n"),
      ROOT,
    );

    expect(files).toHaveLength(3);
    const impact = summariseImpact(files);
    expect(impact.added).toEqual([join(ROOT, "src/New.java")]);
    expect(impact.updated).toEqual([join(ROOT, "src/A.java")]);
    expect(impact.deleted).toEqual([join(ROOT, "src/Old.java")]);
    expect(impact.moved).toEqual([
      { from: join(ROOT, "src/A.java"), to: join(ROOT, "src/Renamed.java") },
    ]);
  });

  test("collects the lines each patch introduces", () => {
    const files = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: src/A.java",
        "@@",
        " unchanged",
        "-old",
        "+Operación",
        "+OK",
        "*** End Patch",
      ].join("\n"),
      ROOT,
    );
    expect(files[0]?.addedLines).toEqual(["Operación", "OK"]);
    expect(files[0]?.removedLines).toEqual(["old"]);
  });

  test("handles several files in one patch independently", () => {
    const files = parsePatch(
      [
        "*** Update File: a.txt",
        "+a",
        "*** Update File: nested/b.txt",
        "+b",
        "*** Add File: c.txt",
        "+c",
      ].join("\n"),
      ROOT,
    );
    expect(files.map((file) => file.absolutePath)).toEqual([
      join(ROOT, "a.txt"),
      join(ROOT, "nested/b.txt"),
      join(ROOT, "c.txt"),
    ]);
  });

  test("accepts a plain unified diff", () => {
    const files = parsePatch(
      "--- a/src/A.java\n+++ b/src/A.java\n@@ -1 +1 @@\n-old\n+new\n",
      ROOT,
    );
    expect(files[0]?.absolutePath).toBe(join(ROOT, "src/A.java"));
    expect(files[0]?.addedLines).toEqual(["new"]);
  });

  test("rejects malformed patches", () => {
    expect(() => parsePatch("no markers here", ROOT)).toThrow(PatchParseError);
    expect(() => parsePatch("*** Update File: \n", ROOT)).toThrow(
      PatchParseError,
    );
    expect(() =>
      parsePatch("*** Update File: a.txt\n*** Move to:\n", ROOT),
    ).toThrow(PatchParseError);
    expect(() => parsePatch("@@ orphan hunk\n", ROOT)).toThrow(PatchParseError);
  });

  test("normalises Windows separators and drive letters", () => {
    const files = parsePatch("*** Update File: src\\sub\\A.java\n+x\n", ROOT);
    expect(files[0]?.absolutePath).toBe(join(ROOT, "src/sub/A.java"));
  });
});

describe("path safety", () => {
  test("accepts paths inside the root", () => {
    expect(isInsideRoot(ROOT, join(ROOT, "src/A.java"))).toBe(true);
    expect(isInsideRoot(ROOT, ROOT)).toBe(true);
  });

  test("rejects traversal outside the root", () => {
    expect(isInsideRoot(ROOT, join(ROOT, "../../etc/passwd"))).toBe(false);
    expect(isInsideRoot(ROOT, "/etc/passwd")).toBe(false);
    expect(isInsideRoot(ROOT, "/projects/legacy-evil/A.java")).toBe(false);
  });
});

describe("mutation target extraction", () => {
  test("knows which tools mutate files", () => {
    expect(isMutatingTool("edit")).toBe(true);
    expect(isMutatingTool("write")).toBe(true);
    expect(isMutatingTool("patch")).toBe(true);
    expect(isMutatingTool("apply_patch")).toBe(true);
    expect(isMutatingTool("read")).toBe(false);
    expect(isMutatingTool("bash")).toBe(false);
  });

  test("reads edit input in both spellings", () => {
    const [camel] = extractMutationTargets(
      "edit",
      { filePath: "src/A.java", oldString: "a", newString: "b" },
      ROOT,
    );
    expect(camel?.absolutePath).toBe(join(ROOT, "src/A.java"));
    expect(camel?.addedText).toEqual(["b"]);

    const [snake] = extractMutationTargets(
      "edit",
      { file_path: "src/A.java", old_string: "a", new_string: "b" },
      ROOT,
    );
    expect(snake?.addedText).toEqual(["b"]);
  });

  test("reads write content as the added text", () => {
    const [target] = extractMutationTargets(
      "write",
      { filePath: "src/A.java", content: "package a;" },
      ROOT,
    );
    expect(target?.action).toBe("add");
    expect(target?.addedText).toEqual(["package a;"]);
  });

  test("falls back to the patch parser when only patchText is present", () => {
    const targets = extractMutationTargets(
      "apply_patch",
      { patchText: "*** Update File: src/A.java\n+x\n" },
      ROOT,
    );
    expect(targets[0]?.absolutePath).toBe(join(ROOT, "src/A.java"));
    expect(targets[0]?.addedText).toEqual(["x"]);
  });

  test("ignores input without any path", () => {
    expect(extractMutationTargets("edit", { nothing: true }, ROOT)).toEqual([]);
    expect(extractMutationTargets("edit", undefined, ROOT)).toEqual([]);
  });
});
