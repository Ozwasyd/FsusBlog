# Native and tooling style enforcement

This is the executable mapping for issue #1160. The cross-language authority remains [Coding conventions](coding-conventions.md); this document explains how standard native and tooling formatters consume that authority without rewriting legacy files or changing external contracts.

## Entry points

Use the changed-file path during development:

```bash
./tools/format.sh --check
./tools/lint.sh native
./tools/lint.sh scripts
./tools/lint.sh docs
```

Use `--base <ref>` for stacked branches and `--full` for the authoritative repository scan. The migration acceptance state requires `config/development/native-tooling-style-baseline.json` to contain no file entries; formatter or lint debt cannot be hidden behind a content digest. `--require-tools` additionally fails when a configured external executable is unavailable.

`./tools/format.sh` writes only selected changed files. It normalizes UTF-8/LF/final-newline/trailing whitespace, delegates C++ to `clang-format`, delegates Shell/CMake when their formatters exist, and pretty-prints JSON without sorting semantic keys. Markdown is never destructively wrapped. `--check` is read-only.

## Standard tool adapters

| Surface | Standard configuration | Gate behavior |
| --- | --- | --- |
| C++23 | `.clang-format`, `.clang-tidy` | 4 spaces, Allman braces, grouped includes, C# naming map, analyzer/warning profiles |
| CMake | `.cmake-format.yaml`, `cmake/FsusWarnings.cmake` | 4 spaces, PascalCase project helpers, camelCase locals, preserved built-ins/cache names |
| Shell | `.editorconfig`, `.shellcheckrc` | 4 spaces, strict mode, PascalCase functions, camelCase locals, quoted expansion, ShellCheck/shfmt adapters |
| YAML/GitHub Actions | `.yamllint.yml`, `.github/actionlint.yaml` | 4 spaces, duplicate keys, schema/actionlint adapter, preserved action inputs and SHA pins |
| JSON/JSONC | built-in deterministic parser | UTF-8/LF, 4 spaces, duplicate/NaN/syntax rejection, existing semantic key order |
| Markdown | `.markdownlint-cli2.jsonc` | heading/fence/table/list/trailing-whitespace checks, fail-closed internal links, schema-bound front matter, no line wrapping |

External executables are optional in the portable developer path because not every host image contains every ecosystem CLI. The built-in deterministic checks still run and aggregate violations. Hermetic CI/toolchain images use `--require-tools` so configured standard adapters cannot silently disappear.

Markdownlint is invoked once for the complete selected file set rather than once per document. Its output is parsed back into individual diagnostics so one run exposes every file/rule failure. Inline Markdown lint suppression is disabled. The only rule override is the exact `.github/PULL_REQUEST_TEMPLATE.md` fragment, which does not own a document-level H1; generated `docs/testing.generated.md` and historical `docs/reports/**` evidence are excluded by exact owner paths, while similarly named hand-written documents remain governed.

Optional Markdown front matter must start with `schema: fsusblog.markdown-document.v1`, use unique non-empty scalar fields, and close before document content. A leading delimiter without that schema fails closed instead of being silently ignored. Inline and reference-style relative links are resolved from the owning document; malformed percent encoding, repository escape and missing targets are reported without aborting the remaining scan.

## Native build presets

The root native CMake project is intentionally separate from Emscripten artifact production. It compiles and tests a host-native CRC contract through the same repository source and `FsusWarnings` interface target.

```bash
cmake --workflow --preset native-basic
cmake --workflow --preset native-speed
cmake --workflow --preset native-asan-ubsan
cmake --preset native-fuzz
cmake --build --preset native-fuzz
cmake --build --preset format
cmake --build --preset lint
```

`FSUSBLOG_WARNINGS_AS_ERRORS` is opt-in and attached only to repository-owned targets. Third-party, generated and Emscripten ABI sources do not inherit `-Werror`. ASan/UBSan and fuzzing are explicit presets rather than implicit developer defaults.

## External contracts and exclusions

`config/development/native-tooling-style-exceptions.json` is the executable exception registry. It consumes the #1157 authority in `config/development/authoritative-development-docs.json`; each executable entry must point to an authority exception, a path classification, or the higher-priority language-syntax class. Each entry also has a narrow path scope, external and internal patterns, and positive/negative mappings. It covers C ABI/Wasm exports, compiler intrinsics, generated protocol layout, environment variables, CMake cache keys, GitHub Actions/schema keys, JSON wire keys and CSS-like caller contracts.

An exception preserves only the boundary spelling. Internal wrappers still return to PascalCase/camelCase. Generated, vendor, lock, minified, report and intentionally invalid fixture paths are excluded explicitly; a linter failure cannot create a new wildcard exception.

## Migration discipline

Each formatter-only migration is isolated from semantic changes and recorded by its real commit SHA. The current sequence is native `13e382d6`, JSON `e4cb5b4e`, JSONC `677b4657` / `482035c6`, YAML `e4f192d2`, Shell `4eefccaf`, CMake `cd6926a7`, and Markdown `ba2833d0`. After dependency-ordered integration, those real pure-format commits are added to `.git-blame-ignore-revs`; placeholder hashes and mixed behavior/format commits are rejected.

The positive and aggregate-negative fixtures live under `tests/fixtures/issue-1160-native-tooling-style/`. The focused contract test proves portable fallback behavior, exception boundaries, full-mode digest invalidation, formatter idempotence and wrapper parity.
