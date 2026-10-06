# OpenCode V2 Plugin Specification — Encoding Guard

## Objective

Create a production-ready OpenCode V2 plugin named:

`opencode-encoding-guard`

The plugin must protect legacy source files from encoding corruption when OpenCode agents read, edit, write, or patch files that are **not UTF-8**, especially projects created or maintained in Eclipse that use encodings such as:

- ISO-8859-1
- Windows-1252
- UTF-8
- UTF-8 with BOM
- ASCII when applicable

The primary use case is Java/Eclipse legacy repositories where files may contain Spanish characters such as:

```text
á é í ó ú
Á É Í Ó Ú
ñ Ñ
ü Ü
¿ ¡
```

A file that originally contains:

```text
Información del trámite
Descripción
Contraseña
Operación
Notificación
```

must NEVER become:

```text
InformaciÃ³n del trÃ¡mite
DescripciÃ³n
ContraseÃ±a
OperaciÃ³n
NotificaciÃ³n
```

The agent should work with normal Unicode text internally while the plugin guarantees that the file is persisted using its original encoding.

---

# Core Principle

OpenCode and the model may reason in Unicode/UTF-8 internally.

The plugin owns the boundary between:

```text
Physical file bytes
        ↕
Encoding Guard
        ↕
Unicode text used by the agent
```

The plugin must preserve the original physical representation whenever possible.

For an ISO-8859-1 file:

```text
ISO-8859-1 bytes
      ↓ decode
Unicode text
      ↓ OpenCode edit
Unicode text
      ↓ validate
ISO-8859-1 encode
      ↓
ISO-8859-1 bytes
```

Do NOT solve this by permanently converting the repository to UTF-8.

---

# OpenCode Version

Target **OpenCode V2 plugin API**.

Use the current V2 plugin API and imports rather than the legacy V1 plugin API.

The implementation should follow the current official OpenCode V2 API, using the appropriate current package export, for example the V2 `Plugin.define(...)` API supported by the installed OpenCode version.

The V2 plugin API is currently beta, so:

1. isolate OpenCode-specific integration code;
2. keep encoding logic framework-independent;
3. avoid unnecessary reliance on undocumented internals;
4. verify hook/event types against the current installed OpenCode V2 SDK before implementation.

Do not implement this as a V1 plugin unless explicitly required for compatibility.

---

# Required OpenCode V2 Hooks

Use OpenCode V2 tool hooks.

At minimum:

```ts
ctx.tool.hook("execute.before", ...)
ctx.tool.hook("execute.after", ...)
```

The plugin must inspect mutating tools such as:

```text
edit
write
apply_patch
```

Do not assume `apply_patch` behaves like `edit` or `write`.

For `apply_patch`, paths may be embedded inside `patchText`, so implement a parser capable of identifying every affected path.

Support markers such as:

```text
*** Add File:
*** Update File:
*** Move to:
*** Delete File:
```

The parser must handle a patch that touches multiple files.

The plugin must not rely only on `filePath` being present.

---

# Compatibility with context-mode

The plugin MUST coexist with `context-mode`.

Do not implement:

- context compaction;
- RAG;
- conversation-memory replacement;
- prompt compression;
- context-window management;
- duplicate context indexing.

The responsibilities must remain separate.

```text
context-mode
    ↓
context management / compaction / retrieval

opencode-encoding-guard
    ↓
filesystem encoding integrity
```

The encoding plugin should be transparent to context-mode.

Avoid modifying model context unless a concise warning needs to be surfaced.

---

# Main Requirements

## 1. Detect and preserve encoding per file

Do not assume that the entire repository uses one encoding.

A repository can contain:

```text
src/**/*.java           ISO-8859-1
src/**/*.properties     ISO-8859-1
src/**/*.jsp            ISO-8859-1
pom.xml                  UTF-8
frontend/**/*.js         UTF-8
scripts/**/*.sql         Windows-1252
```

Encoding must therefore be tracked per file.

Create a structure similar to:

```ts
export type SupportedEncoding =
  | "utf8"
  | "utf8-bom"
  | "iso-8859-1"
  | "windows-1252"
  | "ascii";

export type LineEnding = "LF" | "CRLF" | "CR";

export interface FileMetadata {
  path: string;
  encoding: SupportedEncoding;
  encodingSource:
    | "bom"
    | "eclipse"
    | "editorconfig"
    | "configuration"
    | "detection"
    | "fallback";
  bom: boolean;
  lineEnding: LineEnding;
  originalHash: string;
}
```

The exact types may be improved if justified.

---

# 2. Encoding detection priority

Use deterministic configuration before heuristic detection.

Preferred resolution order:

```text
1. Explicit plugin rule for a specific file/glob
2. Eclipse file/folder/project encoding settings
3. .editorconfig charset when applicable
4. BOM
5. Safe deterministic byte analysis
6. Configurable fallback
```

Do not blindly use probabilistic detection if the project explicitly declares an encoding.

Default fallback may be UTF-8, but it must be configurable.

---

# 3. Eclipse support

This plugin is specifically intended to work well with Eclipse legacy projects.

Inspect Eclipse project metadata, especially files such as:

```text
.settings/org.eclipse.core.resources.prefs
```

Support relevant Eclipse encoding declarations where present.

Examples may include project-, folder-, or resource-specific encodings.

Implement hierarchical resolution where the most specific applicable declaration wins.

Conceptually:

```text
file-specific
    ↓
folder-specific
    ↓
project-specific
    ↓
other configured detection
```

Do not hard-code only one exact Eclipse preference line shape without verifying the real preference syntax.

Add unit tests using realistic Eclipse preference examples.

---

# 4. Preserve line endings

The plugin must also preserve:

```text
LF
CRLF
CR
```

A three-line modification must not turn into a whole-file Git diff because line endings changed.

Detect line endings before mutation and restore/preserve them afterwards.

For mixed line-ending files, either:

- preserve exactly when technically practical; or
- detect the dominant line ending and emit a warning.

Do not silently normalize mixed files unless configuration explicitly allows it.

---

# 5. Preserve BOM

Detect and preserve BOM where relevant.

At minimum distinguish:

```text
UTF-8
UTF-8 with BOM
```

Do not accidentally introduce a BOM into a BOM-less file.

Do not accidentally remove a BOM from a file that originally contained one.

---

# 6. Round-trip validation

Never silently lose characters.

Before persisting text using a legacy encoding, validate that every character can be represented.

Conceptually:

```ts
const encoded = encode(text, originalEncoding);
const decoded = decode(encoded, originalEncoding);

if (decoded !== text) {
  throw new EncodingLossError(...);
}
```

The implementation can use a stronger validation method if appropriate.

The important guarantee is:

```text
encode → decode == original Unicode text
```

before the final file is accepted.

---

# 7. Unsupported character protection

Example:

Original file:

```text
ISO-8859-1
```

Agent tries to write:

```text
✅ Operación terminada
```

The character:

```text
✅ U+2705
```

cannot be represented in ISO-8859-1.

The plugin MUST NOT silently produce:

```text
? Operación terminada
```

Default behavior:

```text
BLOCK
```

Return a clear error such as:

```text
Encoding Guard blocked this write.

File:
src/main/java/.../Servicio.java

Encoding:
ISO-8859-1

Unsupported character:
U+2705 ✅

The requested text cannot be represented safely in the original encoding.

Use a representable alternative or explicitly migrate the file encoding.
```

Configuration may later support:

```text
block
warn
allow-lossy
```

but `block` must be the safe default.

---

# 8. No mojibake repair by guessing

The plugin should prevent corruption rather than attempt aggressive automatic mojibake repair.

Do not automatically transform:

```text
InformaciÃ³n
```

into:

```text
Información
```

unless the plugin can prove that the corruption was introduced during the intercepted operation.

Existing repository content may intentionally or accidentally contain such byte sequences.

Never rewrite unrelated content based only on appearance.

---

# 9. Minimal-diff philosophy

Whenever possible:

```text
agent changes 3 lines
→ Git should show approximately 3 changed lines
```

Do not rewrite the entire file merely to perform an encoding conversion unless unavoidable.

Avoid:

- whitespace normalization;
- line-ending normalization;
- BOM changes;
- whole-file formatting;
- unrelated encoding cleanup.

This plugin protects files; it is not a formatter.

---

# 10. File mutation workflow

Implement an operation-scoped registry.

Before a mutating tool executes:

```text
1. Resolve affected files.
2. Read original raw bytes.
3. Detect metadata.
4. Store operation-local metadata.
5. Optionally store original bytes/hash for rollback/validation.
```

After successful execution:

```text
1. Re-read resulting content/bytes.
2. Determine whether OpenCode emitted UTF-8 or changed representation.
3. Recover logical Unicode text safely.
4. Validate representability in the original encoding.
5. Restore original encoding.
6. Restore original line-ending policy.
7. Restore BOM state.
8. Write atomically.
9. Re-read and validate final bytes.
10. Confirm encoding and hash/state.
```

If the tool failed:

```text
Do not transform unrelated files.
Clean operation-local state.
```

Be careful with parallel tool execution.

State must not be stored in a single global mutable variable.

Use a request/operation identifier if OpenCode exposes one.

Otherwise design a safe key from the event and affected path set.

---

# 11. Atomic writes

Final file replacement should be as safe as practical.

Preferred approach:

```text
encode content
    ↓
write temporary sibling file
    ↓
fsync if appropriate
    ↓
atomic rename/replace
```

Avoid leaving a partially written source file after a crash.

Respect platform differences, especially Windows.

---

# 12. apply_patch support

`apply_patch` is mandatory.

Build a dedicated parser module:

```text
src/opencode/apply-patch-paths.ts
```

It should return something conceptually similar to:

```ts
interface PatchImpact {
  added: string[];
  updated: string[];
  moved: Array<{
    from: string;
    to: string;
  }>;
  deleted: string[];
}
```

Requirements:

- multiple files per patch;
- paths relative to project root;
- additions;
- updates;
- moves/renames;
- deletions;
- malformed patch handling;
- path traversal validation.

For updated files:

```text
capture metadata before
restore encoding after
```

For renamed files:

```text
encoding metadata follows the content
```

For new files:

Use configured rules and project/Eclipse defaults because no original file encoding exists.

For deleted files:

No post-write transformation should occur.

---

# 13. New file policy

A new file has no original encoding.

Determine its encoding using:

```text
1. matching explicit rule
2. Eclipse resource/folder/project preference
3. .editorconfig
4. plugin default
```

Example:

```text
existing folder encoding = ISO-8859-1
new Java file in that folder
→ create ISO-8859-1
```

Default new-file encoding should be configurable.

---

# 14. Configuration

Create a clean plugin configuration model.

Example target shape:

```json
{
  "mode": "preserve",
  "fallbackEncoding": "utf8",
  "newFileEncoding": "inherit",
  "preserveLineEndings": true,
  "preserveBom": true,
  "unsupportedCharacters": "block",
  "eclipse": {
    "enabled": true
  },
  "editorconfig": {
    "enabled": true
  },
  "rules": [
    {
      "glob": "**/*.java",
      "encoding": "preserve"
    },
    {
      "glob": "**/*.jsp",
      "encoding": "preserve"
    },
    {
      "glob": "**/*.properties",
      "encoding": "preserve"
    }
  ]
}
```

Improve this shape if the OpenCode V2 plugin option system suggests a better approach.

Do not over-engineer configuration in the first release.

---

# 15. Modes

Support at least:

## preserve

Recommended default.

```text
existing ISO-8859-1 → remains ISO-8859-1
existing UTF-8 → remains UTF-8
existing Windows-1252 → remains Windows-1252
```

## warn

Detect unsafe encoding changes and report them without automatically blocking all operations.

## force

Explicit rules may force an encoding for selected globs.

Example:

```text
legacy/**/*.java → ISO-8859-1
```

`force` must only be active when explicitly configured.

---

# 16. Encoding inspection tool

Expose a plugin tool if supported cleanly by the current V2 API.

Suggested command/tool semantics:

```text
encoding_inspect
```

Input:

```json
{
  "path": "src/main/java/com/example/UsuarioService.java"
}
```

Output:

```text
File:
src/main/java/com/example/UsuarioService.java

Encoding:
ISO-8859-1

Source:
Eclipse project preference

BOM:
No

Line endings:
CRLF

Round-trip:
OK

Protection:
Active
```

This tool must be read-only.

---

# 17. Project scan tool

Optionally expose:

```text
encoding_scan
```

It should scan project files using sensible limits and ignore rules.

Example result:

```text
Encoding Guard — Project Report

UTF-8                74
UTF-8 BOM             3
ISO-8859-1          186
Windows-1252         21
ASCII                 38
Unknown                2

Mixed-encoding repository detected.

Eclipse encoding configuration:
Detected

Files at risk:
2
```

Do not scan huge dependency/build folders by default.

Ignore at minimum common directories such as:

```text
.git
node_modules
target
build
dist
out
.idea caches where irrelevant
```

Honor project ignore configuration where practical.

---

# 18. Logging

Use OpenCode's current structured logging/client API where appropriate.

Do not spam normal output.

Log useful debug information such as:

```text
encoding-guard: captured metadata
encoding-guard: restored ISO-8859-1
encoding-guard: blocked unsupported character
encoding-guard: apply_patch affected 4 files
```

Never log entire confidential source files merely for debugging.

---

# Suggested Architecture

Prefer separation similar to:

```text
opencode-encoding-guard/
├── src/
│   ├── index.ts
│   │
│   ├── opencode/
│   │   ├── plugin.ts
│   │   ├── hooks.ts
│   │   ├── tools.ts
│   │   └── apply-patch-paths.ts
│   │
│   ├── encoding/
│   │   ├── types.ts
│   │   ├── detector.ts
│   │   ├── decoder.ts
│   │   ├── encoder.ts
│   │   ├── representability.ts
│   │   ├── bom.ts
│   │   └── round-trip.ts
│   │
│   ├── eclipse/
│   │   ├── preferences.ts
│   │   └── resolver.ts
│   │
│   ├── editorconfig/
│   │   └── resolver.ts
│   │
│   ├── filesystem/
│   │   ├── metadata.ts
│   │   ├── line-endings.ts
│   │   ├── atomic-write.ts
│   │   └── hashing.ts
│   │
│   ├── config/
│   │   ├── schema.ts
│   │   └── defaults.ts
│   │
│   └── errors/
│       ├── encoding-loss-error.ts
│       └── unsupported-encoding-error.ts
│
├── test/
│   ├── fixtures/
│   │   ├── eclipse-iso-8859-1/
│   │   ├── mixed-encoding/
│   │   ├── windows-1252/
│   │   └── utf8-bom/
│   │
│   ├── encoding/
│   ├── eclipse/
│   ├── apply-patch/
│   └── integration/
│
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
└── CHANGELOG.md
```

You may simplify the structure for the MVP, but keep encoding logic independent from OpenCode hook logic.

---

# Library Guidance

Use a mature encoding library rather than manually implementing character tables.

A library such as `iconv-lite` is acceptable if compatible with the chosen runtime and licensing requirements.

The implementation must support at least:

```text
UTF-8
ISO-8859-1 / Latin-1
Windows-1252
```

Avoid confusing ISO-8859-1 with Windows-1252.

They differ in the 0x80–0x9F range.

Detection should preserve this distinction when evidence exists.

---

# Important ISO-8859-1 vs Windows-1252 Requirement

Do NOT assume every legacy Western European file is ISO-8859-1.

Windows-1252 includes characters such as smart quotes and the euro symbol that ISO-8859-1 does not encode in the same way.

The detector should:

- honor explicit Eclipse/configuration values first;
- distinguish the encodings when byte evidence permits;
- avoid destructive automatic conversion between them.

---

# Security

Treat every filesystem path as untrusted input.

Prevent:

```text
../../../etc/passwd
```

or equivalent traversal outside the project/workspace root.

For patch parsing:

- resolve paths against the OpenCode project root;
- reject paths escaping that root;
- handle Windows drive letters and separators safely.

Do not follow unexpected symlinks outside the allowed workspace unless OpenCode itself explicitly authorizes that behavior and the plugin can prove the path remains safe.

---

# Performance

Hooks execute during agent operations, so they must remain fast.

Requirements:

- no full-project scan during every edit;
- no expensive probabilistic detection when deterministic metadata is available;
- cache Eclipse/project configuration safely;
- invalidate cache when relevant config files change;
- operate only on affected files during edit/write/apply_patch;
- avoid loading unnecessarily huge files fully into memory when a safe alternative exists.

Set a configurable maximum protected file size if necessary.

For files above the limit, warn or use a safe fallback rather than risking excessive memory usage.

---

# Concurrency

Assume multiple tool operations may execute close together.

Do not implement metadata state as:

```ts
let lastFileMetadata;
```

Use operation-scoped state.

A mutation must restore metadata belonging only to its own file/operation.

Add tests that simulate multiple files being mutated concurrently.

---

# Rollback / Failure Policy

If safe re-encoding cannot be guaranteed:

```text
FAIL CLOSED
```

Prefer blocking the operation over silently corrupting source code.

Where possible:

1. preserve original bytes before modification;
2. detect invalid post-edit state;
3. return a clear error;
4. avoid leaving a partially transcoded file.

Do not automatically overwrite legitimate changes with a stale snapshot unless rollback safety is proven.

Document this behavior carefully.

---

# Tests

Tests are mandatory.

## Encoding tests

Include literal byte fixtures, not only JavaScript strings.

Test:

```text
ISO-8859-1:
Información
Descripción
Contraseña
Operación
Notificación
México
José
Muñoz
```

Verify exact final bytes.

---

## Windows-1252

Test:

```text
“Texto”
‘valor’
€
```

and ensure it is not incorrectly treated as strict ISO-8859-1 when configuration says Windows-1252.

---

## UTF-8

Verify normal UTF-8 files remain unchanged except for intended edits.

---

## UTF-8 BOM

Verify BOM preservation.

---

## CRLF

Create fixture using actual CRLF bytes.

Modify one line.

Assert CRLF remains.

---

## Unsupported character

ISO-8859-1 file:

```text
Operación correcta
```

Agent tries:

```text
✅ Operación correcta
```

Expected:

```text
write blocked
```

No lossy `?` replacement.

---

## apply_patch

Test:

- one updated legacy file;
- several updated files;
- mixed UTF-8 + ISO-8859-1 patch;
- add file;
- delete file;
- rename file;
- malformed patch;
- path traversal attempt.

---

## Eclipse

Test:

- project default;
- folder override;
- file override if supported;
- no Eclipse metadata;
- malformed preference file.

---

## Regression: mojibake

Original ISO-8859-1 bytes represent:

```text
Información
```

After an agent edit to an unrelated line, final decoded ISO-8859-1 content must still equal:

```text
Información
```

and not:

```text
InformaciÃ³n
```

This is a release-blocking test.

---

# Git Diff Acceptance Test

Create a real temporary Git repository.

Add an ISO-8859-1 Java file with CRLF.

Commit it.

Modify only one ASCII line through the same logic used by the OpenCode hook.

Run:

```bash
git diff --numstat
```

Expected:

- only intended lines appear changed;
- file encoding remains ISO-8859-1;
- CRLF remains unchanged;
- accented text remains byte-correct.

This should be part of integration testing.

---

# MVP Scope

Version `0.1.0` should focus on reliability.

Must have:

```text
✓ OpenCode V2 plugin
✓ execute.before
✓ execute.after
✓ edit
✓ write
✓ apply_patch
✓ ISO-8859-1
✓ Windows-1252
✓ UTF-8
✓ UTF-8 BOM
✓ per-file metadata
✓ Eclipse encoding resolution
✓ CRLF/LF preservation
✓ unsupported-character blocking
✓ round-trip validation
✓ atomic writes
✓ tests
```

Can wait until later:

```text
advanced statistical detection
UI/dashboard
automatic migration to UTF-8
mojibake repair
large binary handling
encoding analytics/history
```

---

# Non-Goals

Do NOT turn this plugin into:

- a formatter;
- a linter;
- a Git client;
- a context manager;
- a RAG system;
- an automatic repository migration tool;
- an AI memory plugin.

Keep the purpose narrow:

> Preserve the original text encoding and byte-level text-file conventions when OpenCode agents modify source files.

---

# Suggested User Experience

Normal safe modification:

```text
[encoding-guard] UsuarioService.java
ISO-8859-1 preserved · CRLF preserved
```

Prefer debug logging over noisy output if no problem exists.

Unsafe modification:

```text
Encoding Guard blocked an unsafe write.

File:
src/main/java/com/example/UsuarioService.java

Original encoding:
ISO-8859-1

Unsupported character:
U+2705 ✅

No file corruption was allowed.
```

Encoding unexpectedly changed:

```text
Encoding Guard detected an encoding mismatch.

Expected:
ISO-8859-1

Detected after tool execution:
UTF-8

The file was safely restored to ISO-8859-1.
```

---

# README Requirements

Document:

1. What problem the plugin solves.
2. Example of mojibake corruption.
3. Supported encodings.
4. Eclipse integration.
5. OpenCode V2 installation.
6. npm installation when published.
7. local development installation.
8. configuration.
9. interaction with `context-mode`.
10. security/fail-closed behavior.
11. unsupported characters.
12. known limitations.
13. contribution instructions.

Include an example very similar to:

```text
Before:
Información del trámite

Agent edits another line.

Without protection:
InformaciÃ³n del trÃ¡mite

With opencode-encoding-guard:
Información del trámite
```

---

# Package Quality

Prepare the project as if it will be published publicly.

Include:

```text
README.md
LICENSE
CHANGELOG.md
package.json metadata
repository URL placeholder if unknown
keywords
tests
typecheck
lint
build
```

Suggested npm keywords:

```text
opencode
opencode-plugin
encoding
charset
iso-8859-1
latin1
windows-1252
eclipse
legacy
java
mojibake
```

Do not invent a repository URL.

---

# Implementation Strategy

Work in this order:

## Phase 1 — Research current API

Verify against the currently installed OpenCode V2 SDK:

- correct import path;
- `Plugin.define` signature;
- `ctx.tool.hook` event shape;
- how `event.tool` is represented;
- how tool input is exposed;
- `execute.after` status/result fields;
- plugin option registration;
- custom tool registration;
- structured logging API;
- project root/context location API.

Do not guess API names when type definitions are available.

---

## Phase 2 — Encoding core

Implement and fully test framework-independent modules:

```text
decode
encode
representability
BOM
line endings
metadata
round-trip
```

---

## Phase 3 — Eclipse resolver

Implement Eclipse preference parsing and hierarchical resolution.

---

## Phase 4 — OpenCode integration

Implement hooks for:

```text
edit
write
apply_patch
```

Start with one file, then multi-file patches.

---

## Phase 5 — Safety

Add:

```text
atomic writes
path validation
concurrency handling
fail-closed behavior
```

---

## Phase 6 — Integration tests

Run real file-byte tests and Git diff tests.

---

# Acceptance Criteria

The plugin is complete only when all of the following are true.

### A

Given an ISO-8859-1 file containing:

```text
Información
```

and the agent modifies an unrelated ASCII line,

the final file must still contain ISO-8859-1 bytes for:

```text
Información
```

---

### B

Opening the final file in Eclipse using its configured ISO-8859-1 encoding must display the text correctly.

---

### C

`file`, a hex viewer, or equivalent byte-level verification must confirm the file was not silently converted to UTF-8.

---

### D

Git diff must not show unrelated accented lines as changed.

---

### E

CRLF/LF convention must remain unchanged.

---

### F

UTF-8 files must continue working normally.

---

### G

A single `apply_patch` affecting both UTF-8 and ISO-8859-1 files must preserve each file independently.

---

### H

Unrepresentable Unicode must be rejected rather than replaced with `?`.

---

### I

The plugin must load and function under current OpenCode V2 without relying on deprecated V1 hook syntax.

---

### J

`context-mode` can remain enabled simultaneously without duplicated context-management behavior.

---

# Agent Instructions

You are responsible for implementing the plugin, not merely producing a design.

Before coding:

1. inspect the current repository;
2. inspect the installed OpenCode V2 types/API;
3. verify assumptions against current official OpenCode V2 documentation or SDK types;
4. identify the runtime/package manager already used;
5. avoid changing unrelated repository conventions.

While coding:

- favor simple, explicit architecture;
- do not suppress type errors;
- do not use `any` unless absolutely necessary and justified;
- do not swallow encoding exceptions;
- do not perform lossy conversion silently;
- write tests alongside functionality;
- keep OpenCode integration isolated from encoding logic;
- keep compatibility with context-mode.

After coding:

1. run typecheck;
2. run tests;
3. run lint if configured;
4. run build;
5. execute an ISO-8859-1 integration fixture;
6. execute a mixed UTF-8/ISO-8859-1 `apply_patch` fixture;
7. verify exact bytes;
8. verify Git diff;
9. summarize all files created/modified;
10. document remaining limitations.

If an OpenCode V2 API differs from this specification, use the actual current typed API and document the difference rather than forcing obsolete syntax.

---

# Definition of Done

The result should be a plugin that allows a developer to keep a legacy Eclipse repository such as:

```text
ISO-8859-1 + CRLF
```

while allowing an OpenCode agent to edit it naturally without corrupting Spanish accented characters.

The developer should no longer need to manually repair:

```text
Ã¡ Ã© Ã­ Ã³ Ãº Ã±
```

after AI-assisted edits.

The plugin's most important guarantee is:

> Existing text that the agent did not intend to change must remain byte-correct and encoding-correct after every supported file mutation.
