# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-06

First release.

### Added

- OpenCode V2 plugin using `ctx.tool.hook("execute.before" | "execute.after")` and the
  `Plugin.Plugin` type. No dependency on V1 hook syntax.
- Protection for `edit`, `write`, `patch` / `apply_patch` and `multiedit`.
- UTF-8 staging strategy: legacy files are rewritten as exact UTF-8 while the tool runs and restored
  afterwards, so the tool never reads bytes it would destroy as U+FFFD.
- Per-file encoding metadata: encoding, source, BOM, line endings, size and sha256 of the original
  bytes.
- Encoding support for ISO-8859-1, Windows-1252, ASCII, UTF-8 and UTF-8 with BOM, keeping
  ISO-8859-1 and Windows-1252 distinct.
- Encoding resolution order: rule → Eclipse → `.editorconfig` → BOM → byte analysis → fallback.
- Eclipse `.settings/org.eclipse.core.resources.prefs` parsing with hierarchical
  file → folder → project → default resolution.
- `.editorconfig` `charset` and `end_of_line` support.
- LF / CRLF / CR preservation; mixed-line-ending files are reported, never silently normalised.
- BOM preservation in both directions (never added, never removed).
- Round-trip validation (`encode → decode`) and blocking of unrepresentable characters, with
  `block` / `warn` / `allow-lossy` policies (`block` is the default).
- `apply_patch` parser supporting `*** Add File`, `*** Update File`, `*** Move to:`,
  `*** Delete File` and plain unified diffs, including multi-file patches and malformed input.
- Atomic writes (temp file, flush, rename) plus post-write byte verification.
- Path traversal protection against the project root.
- Operation-scoped registry keyed by `Tool.CallID` for concurrency safety.
- Read-only `encoding_inspect` and `encoding_scan` tools.
- Configuration via `.encoding-guard.json` and OpenCode plugin options.
- 82 tests, including a real Git diff acceptance test on an ISO-8859-1 + CRLF file.

### Known limitations

- A hard crash between the `before` and `after` hooks can leave a staged file as UTF-8.
- Files above `maxFileBytes` are not protected.
- Mixed line-ending files are left as the tool wrote them.