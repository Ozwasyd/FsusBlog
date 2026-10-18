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

Install the Markdown toolchain from the committed lockfile with Node.js 22 or newer:

```bash
npm ci --ignore-scripts --prefix tools/style/markdown-toolchain
./tools/lint.sh docs --require-tools --base origin/master
node --test tests/tools/native-tooling-style.test.mjs
```

The original checker resolves Markdownlint from this repository's `tools/style/markdown-toolchain/node_modules/markdownlint-cli2/` and runs its bin with the current Node executable. It does not search `PATH` or `NODE_PATH` for Markdownlint. The exact `0.23.1` dependency matches the original structured-span adapter's package version, export and bin checks; changing it requires verifying that adapter's actual API compatibility. A missing install remains a required-tool failure in SOURCE. Installation does not run package lifecycle scripts or change the Markdown rules, source checks or test registration.

`./tools/format.sh` writes only selected changed files. It normalizes UTF-8/LF/final-newline/trailing whitespace, delegates C++ to `clang-format`, delegates Shell/CMake when their formatters exist, and pretty-prints JSON without sorting semantic keys. Markdown is never destructively wrapped. `--check` is read-only.

## Line-ending invariant

`.gitattributes` is the checkout authority: every Git-recognized text file resolves to `eol=lf` unless the repository adds a narrow, documented `eol=crlf` exception for a Windows-native contract that demonstrably requires it. The repository currently has no such tracked exception. Binary files remain classified by Git as non-text and are never rewritten by the line-ending gate.

Run the byte-level repository check with:

```bash
node tools/style/line-ending-invariant.mjs
```

The check enumerates only Git-tracked files, resolves each file's `text` and `eol` attributes, and reads the actual worktree bytes. LF-policy files fail on CRLF, mixed LF/CRLF, or a lone carriage return. Explicit CRLF exceptions fail on LF or mixed endings. Binary files are skipped. Check mode never rewrites a file.

On Windows, diagnose the effective Git configuration and index/worktree state with:

```bash
git config --show-origin --get core.autocrlf
git config --show-origin --get core.eol
git config --show-origin --get core.safecrlf
git ls-files --eol
```

The repository-local setup may be pinned without changing the developer's global Git configuration:

```bash
git config --local core.autocrlf false
git config --local core.eol lf
git config --local core.safecrlf true
```

Parser tolerance remains appropriate only at genuinely external or platform-provided text boundaries. Repository-owned files must satisfy this invariant instead of depending on parser-side `\r?\n` compatibility.

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

## Registered document-fragment compatibility

The initial finite `markdownCompatibilityAnchors` policy records preserve nine exact legacy aliases in the current backend-owned `docs/api/schemas-and-errors.md`. Their provenance is the heading translation in `fdc2414d10cf3b211b7427a1d04be5d4af6cfd49`; provenance is traceability, not a qualification or ancestry gate. The source check requires each byte-exact empty `<a id="ID"></a>` line exactly once, in active Markdown immediately before its registered heading and before generated sections. It rejects missing, duplicate, changed, hidden or misplaced aliases without freezing line numbers or the full document digest.

The standard Markdownlint configuration remains unchanged: MD033/default rules stay enabled, inline suppression stays disabled, and no `allowed_elements: ["a"]` or document exclusion is added. For batches containing this registered document, the original native checker invokes the installed Markdownlint CLI's public `main` and original default formatter through one task-owned child. The only options override adds a formatter in the same native checker to retain each original parser `errorRange` (column and token length); it does not add a parser, rule, dependency or alternate authority. The default formatter's raw diagnostics and the raw CLI exit remain intact. A bare CLI still reports its nine MD033 findings and exits 1: only this registered native compatibility classification may admit them after independent governance review.

Classification requires a unique real MD033 opening-token span with the exact registered file, active source line, whole empty-anchor syntax and associated heading. Matching `Element: a`, a line number, a caller label or an abbreviated text-only diagnostic is insufficient. Original raw diagnostics must correspond one-to-one to the structured formatter results; source drift, missing/duplicate span evidence, an abnormal exit or invocation failure refuses admission. Every unclassified diagnostic, including additional a-elements and other HTML, remains a failure. Baseline contents, other overrides, exclusions and existing Markdown rules are not changed.

Portable mode can report source-closure defects but refuses admission of registered aliases without the actual parser spans, even when other external tools are optional. The required-tool path and its actual positive/refusal controls are separate from original mock-transport and portable fixtures. Install the locked toolchain and run `node --test tests/tools/native-tooling-style.test.mjs`, then the relevant `./tools/lint.sh docs --require-tools` selection. Fixture results do not prove whole-repository zero debt, product/API behavior, generated facts, independent acceptance, merge or promotion. The original test remains a manual diagnostic unless its existing lifecycle owner separately changes registration.

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

The NuGet-produced `tests/migration/packages.lock.json` is registered as the exact
`lock` / `PackageManager` owner path in both the authority registry and native/tooling
selection policy. Its package-manager byte layout is preserved in lint and write-format
modes. This is not a directory-wide or filename-only exclusion: neighboring handwritten
JSON and nested or additional `packages.lock` paths remain governed. Source-style
selection does not validate dependencies; the Migration owner still requires NuGet
locked restore and canonical execution evidence.

## Migration discipline

Each formatter-only migration is isolated from semantic changes and recorded by its real, reachable commit SHA. Dependency-ordered integration required a few current-baseline batches where later issues added files after the first migration; every batch remains purely mechanical.

| Surface | Pure format commit(s) |
| --- | --- |
| C++ | `6e140ce9def52fb5120c48a377ef7a4a4fdf16c9` |
| JSON / JSONC | `dc804d61a416c12306724dc8fa8a251bc04da833`, `98b7f65b0df3715ef21a5f4b9c6c9d6b39cfa01e`, `2af86bc584f263d4177a5596da110ebbe8c67081` |
| YAML | `5108de15b762877205b30527c0cdedccc2fe84c2` |
| CMake | `b3dab49538a9b24d0047e387f20595b58c39c0c8` |
| Markdown | `553a3f4fafb7bcd2c8cb048a62d8378f153d59d7`, `2d4101efba4e9b056a291ca4d1eed50cec07168f`, `494b36e41942402cc35c5997bb0a6840e846af57` |
| Shell | `465c8b3cf0387f157d5f82cf8bab5df1964ddf5a` |

The same exact SHA set is registered in `.git-blame-ignore-revs`; placeholder hashes and mixed behavior/format commits are rejected.

The positive and aggregate-negative fixtures live under `tests/fixtures/native-tooling-style/`. The focused contract test proves portable fallback behavior, exception boundaries, full-mode digest invalidation, formatter idempotence and wrapper parity.
