# Coding conventions

This is FsusBlog's single cross-language coding specification. `AGENTS.md` defines only the code-agent role and operating procedure; security, protocol, database, and release documents continue to govern their own semantics without creating a peer style authority.

The mother standard is Microsoft's [.NET coding conventions](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/coding-conventions) and [C# identifier naming rules](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/identifier-names). Repository rules map those conventions to other languages; formatters and linters enforce the standard but do not define it.

## Priority

Resolve conflicts in this strict order:

```text
external wire / ABI / database / third-party contract
    > language syntax requirements
    > FsusBlog C# mother-standard mapping
    > formatter / linter defaults
    > personal IDE settings
```

Security, privacy, AEDS protocol, and release-gate semantic requirements always apply. They may require an external name, field order, or binary layout to remain unchanged, but cannot arbitrarily change internal adapter names or ordinary source formatting. When tool defaults conflict with this document, adjust tool configuration or register a narrow exception rather than changing the standard to accommodate the tool.

## Repository baseline

All handwritten text source follows these defaults:

- UTF-8 (without BOM), LF, one final newline, and no trailing whitespace;
- 4 spaces, never Tab indentation; continuation lines add one 4-space level;
- one statement and one declaration per line, with only necessary blank lines between logical blocks;
- import/include/using groups in platform/standard library, third-party, and repository-internal order, stably sorted within each group;
- comments explain constraints and reasons instead of repeating code; public contracts use the language's documentation form; see [Code intent governance](code-intent-governance.md) for high-value intent and performance claims;
- TODO/FIXME only in the form `TODO(#1234): reason; removal condition: observable exit condition.`, with an open issue and removal condition; owner-only or unowned placeholders are forbidden;
- TOML agent/tool configuration belongs to the `repository-config` style owner; keep top-level keys stable, preserve external consumer field names, and make each multiline instruction a complete, reviewable constraint;
- XML configuration belongs to the `repository-config` style owner; preserve schema-defined element/attribute names, casing, namespace, and structure. Apply the repository text baseline only where the schema permits it; do not rewrite external elements such as `TileColor` with the internal naming map.

Allman braces apply to C# and hand-written repository C++. TS/JS/Vue, CSS, Shell, CMake, YAML, JSON, and Markdown follow language syntax and forms stably expressible by their ecosystem tools; do not apply Allman mechanically.

## Naming map

| C# mother rule | Cross-language mapping |
| --- | --- |
| namespace, type, public member, method, and local function use `PascalCase` | TS class/type/component uses `PascalCase`; Vue component files use `PascalCase.vue`; C++ public types and Shell functions use `PascalCase` |
| interfaces use `I` + `PascalCase` | Only C# interfaces require `I`; do not add `I` mechanically to TS structural types |
| parameters/locals use `camelCase` | TS/JS/C++ locals and Shell local variables use `camelCase` |
| private instance fields use `_camelCase` | Required in C#; other languages use `camelCase` or private syntax when compatible with their ecosystem and formatter |
| private static fields use `s_camelCase` | Required in C#; TS/JS static private fields use language-private syntax and retain `camelCase` |
| thread-static fields use `t_camelCase` | Use only in languages supporting that storage semantic; do not disguise an ordinary async-context variable as thread-static |
| constants use `PascalCase` | C# uses `PascalCase`; JS/TS module constants use `camelCase`, with registered external-environment exceptions |
| public contract names remain stable and readable | Preserve wire/ABI names verbatim; internal DTOs/adapters continue to use this table |
| module/file names express the primary owner | C# files match their primary type; TS modules use existing `camelCase.ts`; Vue components use `PascalCase.vue` |

## C# and .NET

- Use 4 spaces, Allman braces, and one statement/declaration per line; when a binary expression must wrap, put the break before the operator.
- Namespaces, types, methods, properties, events, and public fields use `PascalCase`; interfaces use the `I` prefix.
- Parameters/locals use `camelCase`; private/internal instance, static, and thread-static fields use `_camelCase`, `s_camelCase`, and `t_camelCase`; constants use `PascalCase`.
- Place `using` directives in the common file-level region, with the `System` group first, followed by third-party and `FsusBlog`, stably sorted within each group.
- Write meaningful XML documentation for public cross-assembly contracts, protocol/codec extension points, and security, lifecycle, or ownership types; do not generate empty comments for internal helpers.
- Records, primary constructors, collection expressions, and pattern matching follow the same naming, indentation, and one-declaration-per-line rules.
- The creator of a `CancellationTokenSource` owns disposal: timeout or linked tokens must be `using`/`Dispose`d in the same operation scope; never return or cache a bare `.Token` whose owner is lost. Use `TimeoutCancellationScope` when caller cancellation must be distinguished from timeout; never use `CancellationToken.None`, static delayed cleanup, or GC in place of owner disposal.

## TypeScript, JavaScript, and Vue

- Use 4 spaces and the brace form stably expressed by project ESLint/TypeScript; do not apply C# Allman mechanically to JS grammar.
- Components, classes, and types use `PascalCase`; functions, variables, composables, and module exports use `camelCase`.
- Order imports as runtime/platform, third-party, `@/` or repository-internal, then relative; use `import type` for type-only imports.
- Keep Vue SFC sections in the existing `<script setup>`, `<template>`, `<style>` order; props/emits are public contracts and renames must update callers.
- Use TSDoc on public functions/types for boundaries the type system cannot express; do not repeat comments for ordinary local logic.

## CSS

- Selectors and custom properties use kebab-case, 4 spaces, and one declaration per line.
- Component scope, theme tokens, and the reduced-motion contract take precedence over personal selector preferences.
- Preserve class/custom-property names when they are external DOM/CSS contracts; do not copy kebab-case into internal TS adapters.

## C

- C11 or later, 4 spaces, and Allman braces; system and third-party headers precede project headers.
- Functions and types use `PascalCase`; module-static/local names use `camelCase`; expose Wasm C ABI exports through a narrow adapter while preserving external `snake_case`.
- Do not apply C++ or STL rules by default; mark boundaries and lifetimes explicitly in security-sensitive code.

## C++

- Handwritten C++23 uses 4 spaces and Allman braces; order header includes as the corresponding header, standard library, third-party, then repository headers.
- Types/public functions use `PascalCase`, locals/parameters use `camelCase`, and macros/C ABI exports retain external forms only when the contract requires them.
- Expose Wasm exports through a narrow adapter; do not spread external `snake_case` into the implementation.

## CMake

- Use 4 spaces; built-in commands retain CMake-defined names, while project variables and targets use existing stable names.
- Group and stably sort a target's sources/options by responsibility; do not rewrite CMake grammar to imitate C# braces.

## Shell

- POSIX/Bash syntax takes precedence over brace mapping; use 4 spaces and put functions/control blocks on clearly separated lines.
- PowerShell also uses 4 spaces; functions use `PascalCase`, local variables use `camelCase`, and native resources must be released in `finally`.
- Exported environment variables use `UPPER_SNAKE_CASE`; repository functions use `PascalCase` and local variables use `camelCase`; retain external names only for registered public Shell APIs or environment contracts.
- New scripts use fail-closed argument parsing, quoted variable expansion, and a cleanup `trap`.

## Python

- Python tooling uses 4 spaces, standard-library-first import groups, and `snake_case` function/local names; classes use `PascalCase`.
- Script entry points return an explicit exit status; the creator closes subprocesses, files, and temporary resources. Broad exception handlers must not swallow governance failures.
- Express repository paths, process identity, and platform differences through narrow adapters; do not duplicate an existing Shell or Node owner.

## YAML

- Use 4 spaces and no Tabs; stably order mapping keys according to schema/consumer conventions.
- Preserve GitHub Actions keys, third-party action inputs, and external schema fields verbatim.
- Prefer repository generators or readable anchors for repeated structures; do not use anchors to hide permission or release boundaries.

## JSON

- Use 4 spaces, standard JSON double quotes, and no trailing comma; key order follows stable schema/generator output.
- Preserve API/wire fields verbatim; map internal models and adapters to the C# mother standard.
- Do not format generated manifests by hand; modify the source or generator.

## Markdown

- Do not skip heading levels; label fenced code blocks with a language, and make relative links point to real files.
- Define each standard only here; other documents link to the specific heading instead of copying complete rule tables.
- Command examples must resolve to existing scripts or package scripts; do not present pseudo-commands as executable instructions.

Existing externally addressable document fragments are compatibility contracts, not a general permission to embed HTML. The native style owner registers exact maintained-document paths, empty anchor IDs, associated headings and source provenance in `config/development/native-tooling-style-policy.json`. Its initial nine API aliases preserve the pre-translation fragment spelling. Admission requires both actual source closure and a uniquely bound original Markdownlint MD033 parser span; other HTML, changed or hidden aliases and unavailable span evidence fail closed. Do not disable MD033, add an element-wide allowance, use inline suppression or turn a source-control fixture into approval. See [Native and tooling style enforcement](native-tooling-style-enforcement.md#registered-document-fragment-compatibility).

## Lua

- Use 4 spaces; plugin entry points live under `examples/plugins/` and are not embedded in C# or TypeScript flows.
- Follow the plugin SDK contract for host APIs, error handling, and module return values; do not depend on global I/O, system calls, or undeclared cross-module state.
- Match the plugin examples for comments and formatting; example code is governed handwritten source.

## SQL

- Use uppercase SQL keywords, 4 spaces, and line breaks for complex clauses; keep migrations repeatedly reviewable.
- PostgreSQL columns, indexes, constraints, and migration identities are external persistence contracts and cannot be renamed directly for an internal naming rule.
- Map query results explicitly to internal names when they enter C#/TS.

## External contract exception registry

Exceptions protect external names only. When an internal adapter exists, internal names still follow the C# mother-standard mapping. The following IDs correspond one-to-one with `config/development/authoritative-development-docs.json`:

| Exception ID | External surface | Internal rule |
| --- | --- | --- |
| `json-api-field` | JSON/API field | Preserve the wire key; DTO/property/adapter uses the language's internal naming |
| `postgres-column-migration` | PostgreSQL column, constraint, migration SQL | Preserve database identity; reader/model uses internal naming |
| `http-header` | HTTP header | Preserve header spelling; constants/accessors use internal naming |
| `redis-key` | Redis key/prefix | Preserve the serialized key; builder methods use internal naming |
| `c-abi-wasm-export` | C ABI/Wasm export | Preserve the export symbol; C++/TS wrappers use internal naming |
| `environment-variable` | Process/container environment variable | Preserve `UPPER_SNAKE_CASE`; options properties use internal naming |
| `css-selector-custom-property` | CSS class/custom property | Preserve kebab-case; component tokens/accessors use internal naming |
| `shell-environment-variable` | Exported Shell environment variable | Preserve `UPPER_SNAKE_CASE`; script locals follow the Shell mapping |
| `cmake-built-in` | CMake built-in command/property | Preserve the CMake name; project wrappers/documentation use internal naming |
| `third-party-sdk-callback` | Third-party callback/interface | Preserve the SDK signature; adapt immediately at the boundary |

Each new exception must include positive external/internal examples and a negative example showing the external name leaking inward; `legacy` or “formatter unsupported” is not a permanent reason.

## Generated, vendor, fixture, and tool exceptions

- `generated`: change only the source/generator; rebuild generated files with the owner's command. Generated headers and output formatting are not handwritten-style precedents.
- `vendor`: preserve upstream formatting and license; do not reformat it to repository style. Make changes through an overlay/patch layer.
- `fixture`: may intentionally contain invalid formatting to prove gate rejection, but must live under a classified fixture path with documented test intent.
- `lock`: the package manager owns order and formatting; do not organize it by hand.
- `minified`: accept only traceable generator/source output; it is not a source-style input.

These are explicitly declared narrow exceptions, not wildcard permission to ignore arbitrary directories.

The compressed dependency-migration overlay at
`config/dependencies/fsusui-public-npm-migration.patch.gz` is registered under the
existing `vendor` / `DependencyOwner` classification, like dependency overlay inputs.
It is a fixed input to `tools/dependencies/migrate-fsusui-public-npm.mjs`, not output
generated by that consumer. Preserve the archive bytes; its exact path, SHA-256,
regular-file identity, gzip validity and Git patch applicability remain validated by
the consumer before migration. This registration does not exempt neighboring archives,
the dependency directory or `.gz` files generally, and does not authorize a migration,
dependency upgrade or release.

The consumer also has a fixed, digest-pinned context repair input at
`config/dependencies/fsusui-public-npm-migration-context.patch`. It replaces only
the archived workflow, container and final-image hunks whose owners have changed.
The consumer requires the complete SHA-256 identity of each of those three current
source files before composing the patch, then retains strict cached Git apply checks.
It does not retry a failed application with fuzzy or three-way merging. Both inputs
are retired in the migration transaction; the archive's original bytes and pin,
verified-event requirement and complete private-reference refusal remain unchanged.

## Imports and comments

All languages follow the dependency direction “platform/standard → third-party → repository/local”; language-mandated order (such as the corresponding C++ header) takes precedence. Import order must not hide cyclic dependencies.

Put short comments before the statement they explain. Public contract comments describe inputs, outputs, failures, and security boundaries; TODO/FIXME must bind an open issue, removal condition, and registry entry. Put history, release records, end-of-line comments, and long rationale in `docs/`, not in hot paths. Do not mix structural facts with measured performance conclusions; see [Code intent governance](code-intent-governance.md) for markers, S/M/R/C levels, and fail-closed conditions.

## Enforcement

Run the authoritative-document gates:

```bash
node tools/docs/check-authoritative-development-docs.mjs
node tools/governance/check-code-intent.mjs
```

The gates read paths, symbols, commands, style owners, external exceptions, and generated/vendor/fixture classifications from `config/development/authoritative-development-docs.json`, then aggregate all errors before failing. Later formatter/linter checks must consume this baseline; do not create another peer “sole coding standard.”
