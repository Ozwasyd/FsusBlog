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

Portable mode can report source-closure defects but refuses admission of registered aliases without the actual parser spans, even when other external tools are optional. The required-tool path and its actual positive/refusal controls are separate from original mock-transport and portable fixtures. Run `node --test tests/tools/native-tooling-style.test.mjs` with the original Markdownlint CLI available on `PATH`, then the relevant `./tools/lint.sh docs --require-tools` selection. Fixture results do not prove whole-repository zero debt, product/API behavior, generated facts, independent acceptance, merge or promotion. The original test remains a manual diagnostic unless its existing lifecycle owner separately changes registration.

## Command-wrapper analysis inputs

The owner-controlled [command input registry](../../config/development/command-wrapper-input-registry.json) declares only the correctness Landlock wrapper's caller-owned `main.argc` and `main.argv` inputs. This is not a command allowlist or an exemption for matching source bytes. Required-tools lint validates the authority-owned native selection policy before the registered TU can be excluded or skipped by a full-mode hash baseline; unrelated explicitly selected files retain their original behavior. Before selecting the TU-local analyzer model, the checker independently validates the existing correctness runner's complete reviewed command admission chain, actual environment and executable identity refusals, the original compiler's complete strict command, the approved compiler/subprogram/spec/header/macro closure, and the wrapper's closed semantic AST. Missing, duplicate, foreign, redirected, stale or widened declarations fail closed. All other translation units retain the default taint model.

The independent Clang semantic query retains the original language and optimization inputs and proves its own preprocessed source tokens and critical macro values match the production compiler view. It does not claim to be a GCC AST, and it does not replace the original `cc -std=c11 -O2 -Wall -Wextra -Werror` compile or strict analyzer diagnostics. Unreviewed preprocessing directives, environment inputs, toolchain/header drift and indirect or undeclared environment, stream, file, socket, IPC and pointer inputs are refused before controlled CLI assumptions can be applied.

Only the admitted TU receives the controlled-environment analyzer option. The additive [taint source configuration](../../config/development/command-wrapper-taint-sources.yml) restores explicit environment-return sources without adding filters or disabling any default sink or propagation. Analysis uses the exact approved entry in a private read-only compile database and an explicit authority-owned `.clang-tidy`; source, original/private database, toolchain, headers, macros and owner closure are revalidated after execution. These checks do not claim atomic isolation from hostile concurrent filesystem modification.

Registry and checker sources are loaded from the independently selected checker checkout, never from a candidate-selected proof or baseline. A bootstrap candidate's local model result and component self-tests remain nonqualifying until the separately authorized owner process freezes and independently reviews the authority, promotes it, completes equivalent local CI, merges the PR and rechecks master. The old/base checker's expected taint rejection must remain visible. Roll back the exact model authority increment if input ownership, preprocessing parity or original confinement/opaque-argument forwarding no longer holds; do not suppress diagnostics, narrow the existing CLI, or grant an unknown input class to recover a green result.

The separate [metadata v2 semantic probe](../../tools/style/command-wrapper-input-ast-v2.mjs) models the current helper's decimal metadata conversion, two descriptor observations, exact device/inode/uid/mode comparisons and rule creation through the same verified alias descriptor. Its finite statement productions and actual AST call, field, flag and conversion checks retain `main.argc` and `main.argv` as the only controlled classes; descriptor identities, the decimal end cursor and errno remain untrusted observations. It refuses metadata-to-command flow, mutable borrowed aliases, substituted descriptors, unapproved call/declaration families and macro drift. Private metadata parameter/local renaming does not grant new effects. The observed glibc C23 conversion alias still requires independent compiler/header qualification.

`AllowPath` refuses a null path with `EINVAL` and exit 125 before calling `open`.
Its finite probe production retains the original declared path operand, access
rights, descriptor rule and close operation. The original network owner tests
this boundary and executes a removed-guard negative control; valid paths retain
their existing open/error behavior. This component evidence does not qualify the
caller profile or actual confinement.

Run `node --test tests/tools/command-wrapper-metadata-input.test.mjs` with real Clang for this additional component probe. It returns no analyzer options and always reports `qualificationEligible: false` and `policyPromotion: false`. The required-tools checker, original v1 modules, caller roster and compiler/analyzer/header seals do not select v2 and remain unchanged. Neither these source probes nor the execution-envelope's link-time fault adapters establish real Landlock/systemd confinement, complete caller admission or trusted policy promotion. Integrating v2 into authority requires independent review, a separately versioned complete current compile/caller profile and the original positive/refusal/native/runtime gates.

The [current compiler probe](../../tools/style/command-wrapper-compile-probe-v2.mjs)
adds the current `sys/stat.h` include to a separately versioned finite directive
sequence and applies the metadata AST productions after real strict compilation.
It binds complete GCC and Clang header/macro observations, own-token parity,
compiler/subprogram/spec identities, and before/after revalidation. A relocated
Clang installation requires its exact observed resource directory plus every
individual resource header identity; arbitrary include flags remain refused.
The [current caller probe](../../tools/style/command-wrapper-caller-probe-v2.mjs)
uses the existing finite source inspector to retain all original caller anchors
and follow their complete current imports. It records the actual indexed files,
candidate commit and parser executable, refuses missing/redirected/drifted files,
and rechecks the closure. Its joined source profile requires the caller and
compiler observations to describe the same C bytes. Caller-supplied digests or
approval records cannot replace those observations.

Run `node --test tests/tools/command-wrapper-current-profile.test.mjs` with real
`cc`, Clang and strace. The tests observe the unchanged production compile through
strace and exercise the current method's positive, drift and cleanup controls.
The resulting profile is an **unpromoted proposal** requiring independent
semantic review of every source owner and toolchain input. It always reports
`callerInputAdmission: false`, `qualificationEligible: false`,
`policyPromotion: false` and empty analyzer options. These methods do not update
the v1 registry, select an analyzer model, grant a trusted native pass or qualify
Landlock/systemd runtime confinement. A task's GCC/Clang observations cannot
silently replace the independently approved native profile.

The current source-integration candidate preserves the master caller's exact
millisecond and actual-observation temporal contract, pinned matrix host input,
and private .NET scratch namespace/cleanup ownership. Its finite caller roster
extends the original 41-file closure with the one actual master scratch owner
imported by the network and systemd paths. Each changed owner is reviewed against
its complete current source and original behavioral controls; merely refreshing
hashes does not authorize a semantic or capability change. The C input admission
still covers only this registered translation unit, never a Bash or Node command
closure. Current command-input authority protection is separate from the
unchanged historical Change Contract policy roster and replay tuples.

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
