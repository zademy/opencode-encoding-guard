# AGENTS.md

OpenCode V2 plugin that keeps a file in its original encoding, line endings and BOM while an agent
edits it. Everything in `src/index.ts` is published API — an export there is a compatibility promise.

## Invariants

Break one and you ship silent source corruption. Each holds on every path, new code included.

- **No lossy decode.** A U+FFFD in the pipeline means the original byte was destroyed before the guard
  could act; that is a stop signal, not something to repair. UTF-8 decoding is fatal on purpose
  (`decodeStrict` in `src/opencode/guard.ts`).
- **Round-trip before write.** Encode and decode only through `src/core/codec.ts`
  (`encodeText` / `decodeBytes` / `canEncode`). iconv-lite substitutes `?` for unmappable characters
  instead of failing, so loss shows up only by comparing a round trip. `Buffer.from(text, encoding)`
  and `toString("latin1")` bypass the codec and collapse the ISO-8859-1 / Windows-1252 distinction.
- **Staging is a pair.** `before` snapshots the original bytes and writes exact UTF-8; `after` re-encodes
  and restores. A path that captures without restoring strands the file as UTF-8. When the tool changed
  nothing, put the snapshot back byte for byte so Git sees no diff.
- **Fail closed.** When the target bytes cannot be produced safely, throw `GuardBlockedError`, or restore
  the snapshot and log — never write something close enough. A blocked edit is recoverable, corrupted
  source is not.
- **Atomic writes only.** `atomicWrite` from `src/core/fs-utils.ts`, never a plain `writeFile` on a target
  path: a crash mid-write must not truncate the original.
- **Representation is preserved, never improved.** Never repair mangled bytes by guessing, never
  normalise mixed line endings, never convert between ISO-8859-1 and Windows-1252.

## Layout

- `src/core/` — bytes, encoding resolution, config sources (Eclipse, `.editorconfig`). Imports no
  `@opencode/plugin`; keep it that way so the core stays testable on its own and the bundle never
  resolves the SDK at runtime.
- `src/opencode/` — hooks, tool-input parsing, guard orchestration. Anything that knows a tool name or a
  hook shape belongs here.
- `src/config.ts` — precedence is plugin options > `.encoding-guard.json` > `DEFAULT_CONFIG`, and loading
  never throws, whatever the file contains.
- Supporting a new mutating tool is one entry in `MUTATING_TOOLS` (`src/opencode/paths.ts`); capture and
  restore then follow automatically.

## Tests

`bun run check` runs typecheck and tests together; both green is the gate.

Tests write real files into a tmpdir and assert on **bytes** — raw buffer contents, `git diff --numstat`,
`file` output. Text-equality assertions pass for corrupt output, so they do not count as evidence.
Fixtures are hand-written literal byte arrays (`test/helpers.ts`), never bytes produced by the code under
test. The git-diff acceptance test drives the same `before`/`after` path the hook uses, because that
round trip through a real Git repo is what proves a one-line edit stays a one-line diff.

## Done means

1. Behaviour change has a byte-level test that fails without the change.
2. `bun run check` is green.
3. `CHANGELOG.md` has an entry (Keep a Changelog + SemVer).
4. A behaviour change to encoding resolution, hooks or the mutation workflow matches
   `OPENCODE_ENCODING_GUARD_SPEC.md`; user-facing behaviour is reflected in `README.md`.

## Agent skills

### Issue tracker

Issues are markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, default strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
