# opencode-encoding-guard

OpenCode V2 plugin that keeps legacy source files byte-correct when an agent edits them.

It preserves each file's **original encoding** (ISO-8859-1, Windows-1252, ASCII, UTF-8, UTF-8 with BOM),
its **line endings** (LF / CRLF / CR) and its **BOM state**. Unrepresentable characters are rejected
instead of being silently written as `?`.

---

## 1. The problem

OpenCode's file tools read and write UTF-8. On a legacy file that is not valid UTF-8, the **read itself
destroys the original bytes**: `ó` stored as the single byte `0xF3` is decoded as U+FFFD (`�`), and the
original byte is gone before any encoding conversion could happen.

```
Before (ISO-8859-1):  Informaci\xF3n del tr\xE1mite

Agent edits an unrelated line with OpenCode's own tools:

After (UTF-8):        Informaci\xEF\xBF\xBDn del tr\xEF\xBF\xBDmite     ← data lost
```

Re-encoding afterwards cannot fix this. The information was destroyed on read.

## 2. What the plugin does

It keeps the tool inside UTF-8 while it works, and owns the bytes around the operation:

| Hook | Action |
| --- | --- |
| `execute.before` | Snapshot original bytes + metadata (encoding, BOM, line endings, hash). Reject writes whose new text cannot be represented in the target encoding. For legacy files that contain non-ASCII bytes, rewrite the file as **exact UTF-8** so the tool reads correct text. |
| `execute.after` | Decode what the tool wrote, restore the original encoding, line endings and BOM, write atomically, re-read and verify. If the tool changed nothing, put the snapshot back byte for byte so Git sees no diff. |

Result: the agent works on clean Unicode text, and the file on disk keeps its original representation.

```
Before:
  Información del trámite        (ISO-8859)

Agent edits another line.

Without protection:
  InformaciÃ³n del trÃ¡mite       (mojibake, or U+FFFD data loss)

With opencode-encoding-guard:
  Información del trámite        (still ISO-8859, byte for byte)
```

## 3. Supported encodings

| Encoding | Notes |
| --- | --- |
| `iso-8859-1` | Latin-1, 1 byte per character |
| `windows-1252` | Distinct from Latin-1: smart quotes and `€` live in `0x80–0x9F` |
| `utf8` | Default |
| `ascii` | US-ASCII |

ISO-8859-1 and Windows-1252 are never conflated, and the plugin never converts between them.
Files with NUL bytes or UTF-16 BOMs are treated as binary and left alone.

## 4. Encoding resolution

Deterministic configuration wins over heuristics. Highest priority first:

1. Explicit plugin rule (`rules` in the config)
2. Eclipse `.settings/org.eclipse.core.resources.prefs` (file → deepest folder → project → default)
3. `.editorconfig` `charset`
4. UTF-8 BOM
5. Byte analysis (ASCII / valid UTF-8 / `0x80–0x9F` ⇒ Windows-1252 / otherwise ISO-8859-1)
6. `fallbackEncoding` (default `utf8`)

Charsets that cannot be round-tripped safely (`Shift_JIS`, UTF-16, …) are **ignored, not guessed**.

### Eclipse

```properties
# .settings/org.eclipse.core.resources.prefs
eclipse.preferences.core.defaultEncoding=UTF-8
/Legacy=encode.ISO-8859-1
/Legacy/src/main/webapp=encode.windows-1252
/Legacy/src/main/webapp/legacy-note.txt=UTF-8
```

Both `encode.<charset>` and a bare charset value are accepted.

## 5. Installation

### From npm

```jsonc
// opencode.json
{
  "plugin": ["opencode-encoding-guard"]
}
```

### Local development

```bash
bun install
bun run build
```

Then add a shim to the global plugin directory — opencode discovers plugins there automatically, while
the `plugin` config key only resolves npm specifiers:

```ts
// ~/.config/opencode/plugins/encoding-guard.ts
export { default } from "/absolute/path/to/opencode-encoding-guard/dist/index.js";
```

Restart the service (`opencode service restart`). The bundled `dist/index.js` is self-contained, so no
dependency has to be installed in the config directory.

For a project-only install use `.opencode/plugins/` instead of `~/.config/opencode/plugins/`.

## 6. Tools

`encoding_inspect` — read-only report for a single file:

```
File: legacy/src/Servicio.java

Encoding: ISO-8859-1

Source: Eclipse project preference

BOM: No

Line endings: CRLF

Round-trip: OK

Protection: Active
```

`encoding_scan` — read-only project summary with a per-encoding histogram, mixed-encoding detection,
Eclipse detection and a list of at-risk files. Ignores `.git`, `node_modules`, `target`, `build`,
`dist`, `out` by default.

## 7. Configuration

Defaults work with no configuration at all. Create `.encoding-guard.json` in the project root to change
them (options passed by OpenCode are merged on top of the file):

```jsonc
{
  "enabled": true,
  "mode": "preserve",              // preserve | warn
  "fallbackEncoding": "utf8",
  "newFileEncoding": "inherit",    // inherit = rule → Eclipse → .editorconfig → fallback
  "preserveLineEndings": true,
  "preserveBom": true,
  "unsupportedCharacters": "block", // block | warn | allow-lossy
  "eclipse": { "enabled": true },
  "editorconfig": { "enabled": true },
  "maxFileBytes": 8388608,
  "debug": false,
  "ignore": [".git", "node_modules", "target", "build", "dist", "out"],
  "rules": [
    { "glob": "legacy/**/*.java", "encoding": "iso-8859-1" }
  ]
}
```

A malformed config file never breaks the plugin; it is ignored and the defaults are used.

## 8. Unsupported characters

Default policy is `block`. The agent receives a precise, actionable error and **the working tree is left
untouched** — the check runs before anything is staged or written:

```
Encoding Guard blocked an unsafe write.

File:
legacy/src/Servicio.java

Original encoding:
ISO-8859-1

Unsupported character:
U+2705 ✅

No file corruption was allowed.

Use a representable alternative ... or migrate the file encoding explicitly.
```

## 9. Safety and failure policy

- **Fail closed.** If safe re-encoding cannot be guaranteed, the original bytes are restored and the
  failure is logged. The plugin prefers blocking over corrupting source.
- **Path safety.** Patch paths are resolved against the project root and rejected if they escape it
  (`../../../etc/passwd`). Windows separators and drive letters are handled.
- **Atomic writes.** Content is written to a sibling temp file, flushed, then renamed over the target.
- **Operation-scoped state.** Metadata lives in a registry keyed by `Tool.CallID`, never in a single
  global variable, so concurrent operations cannot restore each other's snapshots.
- **Binary files** (NUL bytes, UTF-16) are never touched.
- **Oversized files** above `maxFileBytes` are skipped with a warning instead of being buffered.

## 10. Interaction with context-mode

Fully independent. This plugin only owns the filesystem encoding boundary; `context-mode` owns context
management, compaction and retrieval. Neither indexes, compacts or rewrites the other's state, and both
can be enabled at the same time.

## 11. Known limitations

- If the OpenCode process is killed between `before` and `after`, a staged file stays UTF-8 until the
  next edit of that file restores it. The window is one tool call.
- Files above `maxFileBytes` are not protected.
- Statistical encoding detection is not implemented; legacy files with no configuration rely on byte
  analysis, which cannot distinguish two single-byte encodings that differ outside `0x80–0x9F`.
- Mixed line-ending files are reported and left alone rather than normalised.
- Only the `edit`, `write`, `patch` / `apply_patch` and `multiedit` tools are intercepted. Direct writes
  by shell commands (`sed -i`, build tools) are outside the plugin's reach.

## 12. Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # 82 tests
bun run build       # dist/index.js + types
bun run check       # typecheck + test
```

The encoding core under `src/core/` does not import the OpenCode SDK and is testable on its own.

## 13. Contributing

Issues and pull requests are welcome. Please include the byte-level evidence (`xxd`/`file` output, `git
diff --numstat`) for any encoding bug — that is what the test suite asserts on.

## License

MIT