# Frontend style enforcement

`docs/development/coding-conventions.md` is the cross-language authority. This document records the executable TypeScript, JavaScript, Vue and CSS mapping implemented by ESLint and Stylelint; it does not replace the authority or any AEDS, security, privacy, accessibility, motion, UI or performance gate.

## AST toolchain

The authoritative frontend formatter is the AST-aware pair in `tools/frontend/style-toolchain/`: ESLint 10 with typescript-eslint Project Service and eslint-plugin-vue, plus Stylelint 17 with Vue/SCSS custom syntaxes. Prettier is intentionally not an authority because it cannot preserve the repository's Allman brace contract. The toolchain has an independent lockfile so linting never needs GitHub Packages or a published FsusUI build.

Application project options resolve only when ESLint selects a typed TypeScript or Vue source. Untyped Node tooling, including exact-base SOURCE scratch lint, does not construct an unrelated application typecheck project. Typed selection retains the original frontend-root TypeScript resolution and local FsusUI alias checks: missing dependencies still fail, and the application uses the TypeScript version from the original frontend lock rather than a global resolver or alternate package root. No typed rules, project scope or qualification gates are removed.

The covered source sets are:

- `src/frontend/src/**` for TypeScript, JavaScript, Vue, CSS and SCSS;
- `src/frontend/wasm/web/**` for the TypeScript/JavaScript Wasm adapter;
- `src/frontend/scripts/**` and hand-written `src/frontend/public/**/*.js` to preserve the previous JavaScript security scope;
- `tools/**/*.mjs` and `tests/**/*.mjs` for Node tooling;
- generated, public artifacts, vendored dependencies, minified files and intentional fixture directories only through explicit policy exclusions.

Script declaration modules under `src/frontend/scripts/` have the finite suffixes
`.d.mts` (ESM) and `.d.cts` (CommonJS). They use the unchanged typed rule set with
the complete original `src/frontend/tsconfig.node.json` project, rather than the
application Project Service or an inferred fallback project. That configuration
is a policy configuration source and a SOURCE data witness. Bare `.mts`/`.cts`,
declarations in other roots and unknown suffixes do not gain SOURCE support.
The declaration owner requires a regular canonical input, the bound regular Node
configuration, the actual ESLint TypeScript-parser/project configuration, and
exactly one actual JSON report for each input. An ignored, missing, unowned or
out-of-program declaration cannot qualify through a zero-file success. SOURCE
routes declarations through `strict-full` and admits them only after that child
check succeeds; a deleted declaration remains visible in the Git-derived SOURCE
inspection scope and does not receive a nonexistent lint receipt. These source
checks issue no runtime or product qualification. The top-level `vite.config.ts`
remains outside the existing style source sets and requires its original complete
Node compiler checks separately.

The suite-convergence test keeps its canonical `tests/tools/` path and consumes
the three governance module exports from the private local `tools/` package.
`tests/tools/package-lock.json` binds that file dependency. Before running this
test or the static-governance Node contracts directly in a fresh checkout, run
`npm --prefix tests/tools ci --ignore-scripts --no-audit`; the generated
`node_modules` link is not source or an acceptance artifact.

Run the changed-file gate from the frontend package:

```bash
npm --prefix src/frontend run lint
npm --prefix src/frontend run format:check
```

Both commands resolve to the same aggregate entrypoint:

```bash
node tools/frontend/check-frontend-style.mjs --mode changed
```

It reports all ESLint and Stylelint findings in stable file/line/rule order with no maximum-error cutoff. Use `--base origin/master` on stacked branches and repeat `--file <path>` for an explicit selection.

## C# mapping

TypeScript, JavaScript and Vue script use 4 spaces, Allman braces, explicit semicolons, one statement/declaration per line and platform/third-party/internal/relative import groups. Type imports are separate. Typed source enables promise misuse, floating promise, unsafe any/assertion/member access, fallthrough, unreachable and dependency-boundary rules through TypeScript's Project Service rather than a text scanner.

Type-like and Vue component names are PascalCase; parameters and locals are camelCase. The #1157 mapping deliberately keeps `useXxx` for Vue composables, PascalCase without a mandatory `I` for TypeScript structural interfaces, `#camelCase` for ECMAScript private fields, and camelCase for normal module bindings. These are named entries in `config/development/frontend-style-rule-registry.json`, not implicit ecosystem exceptions.

Vue templates use 4-space indentation, one attribute per multiline row, stable closing brackets and PascalCase component references. Standard HTML, ARIA and `data-*` spellings remain browser contracts. Existing public emit names remain unchanged until a semantic caller migration is reviewed.

CSS, SCSS and Vue style blocks use 4 spaces, an Allman opening brace and one declaration per line. CSS classes, BEM selectors and custom properties remain kebab-case contracts; SCSS internal variables, mixins and functions use camelCase. Property order is centrally set to `semantic-preserve`: token dependencies, logical-property fallbacks and component state grouping are not destroyed for alphabetical churn.

## Baseline and modes

The full baseline-aware scan is:

```bash
node tools/frontend/check-frontend-style.mjs --mode full
```

`config/development/frontend-style-baseline.json` records historical violations by file-content digest. An unchanged file may retain only its exact baseline; touching the file invalidates that allowance. `strict-full` ignores the baseline and is the eventual migration proof:

```bash
node tools/frontend/check-frontend-style.mjs --mode strict-full
```

Baseline exemptions additionally require all three whole-repository bindings to match:
the current configuration digest (including the Node runtime), current source-state
digest, and `generatedFrom` equal to `source-state:<current source-state digest>`.
Any mismatch invalidates **all** exemptions, not merely the selected file's allowance.
The mode boundaries are:

- `full` rejects each stale binding explicitly: `baseline configuration digest is
  stale`, `baseline source-state digest is stale`, and `baseline generatedFrom does
  not match the current source-state digest`. All mismatches and all selected ESLint
  and Stylelint findings are aggregated; a clean zero-debt source set still cannot
  certify a stale full-scan baseline. `--file` limits lint selection, not binding scope.
- `changed` applies only valid unchanged-file exemptions. Binding drift removes all
  exemptions but is not itself a global history failure: clean selected source may
  pass, and every selected file-level finding remains visible.
- `strict-full` never applies exemptions. Binding drift is not an additional history
  failure; clean selected source may pass, and all selected debt remains visible.
- `--update-baseline` runs the separate updater rather than these scan-time binding
  diagnostics. Source-state and `generatedFrom` are refreshed only after its existing
  debt/path/identity and reviewed-authority checks succeed. Configuration migration
  still requires the exact prior digest authorization described below. This mode does
  not authorize new debt, count increases, equal-count diagnostic replacement, or
  candidate-authored correction/residual authority.

Missing baselines grant no exemptions. Existing malformed schema/JSON diagnostics and
configuration/governance validation remain enforced in every mode; the mode boundary
above does not suppress them. None of these checks promotes a candidate's policy or
baseline to trusted authority.

Regenerate a reviewed baseline without changing source:

```bash
node tools/frontend/check-frontend-style.mjs --mode full --update-baseline
```

The updater rejects new debt, count increases, and equal-count diagnostic identity
replacement. A malformed historical aggregate can be corrected only with
`--reviewed-baseline-correction config/development/frontend-style-baseline-corrections.json`.
That closed authority binds the unchanged source digest, exact previous and corrected
counts, violation digests and rule maps. Its bytes must already exist at refreshed
`refs/remotes/origin/master`; a candidate cannot add or edit its own correction. The
previous rule sum must prove the malformed aggregate, the corrected rule sum must equal
the corrected count, and the authority becomes unusable once the baseline entry is
replaced.

The independently reviewed parent-import residual is closed in
`config/development/frontend-style-reviewed-residual.json`. It binds exactly 149
`tests/**` and `tools/**` paths and 329
`eslint/import-x/no-relative-parent-imports` diagnostics to the unsuppressed source
SHA-256, canonical diagnostic identity and message digest, per-rule count, prior owner
commit, review issue, reason and terminal condition. Its aggregate declares zero other
diagnostics. Validate the authority without updating the baseline:

```bash
node tools/frontend/reviewed-residual-classification.mjs
```

A downstream baseline update that reaches any bound unsuppressed source must consume the
whole authority with
`--reviewed-residual-classification config/development/frontend-style-reviewed-residual.json`.
The authority bytes must already exist unchanged on an ancestor at refreshed
`refs/remotes/origin/master`. Candidate-authored or missing bytes, extra, omitted,
duplicate or reordered entries, stale source/rule/diagnostic/owner identity, partial
consumption and reuse after a successful update all fail closed. The authority only
admits the exact 329-diagnostic current set from the bound source bytes and requires the
reviewed prior-consumer plus still-unconsumed remote baseline projections. It does not
update the baseline itself and never suppresses `strict-full`.

`--migrate-baseline-paths tests/test-asset-semantic-renames.json` is limited to a
non-empty set of real one-to-one renames whose old paths are absent and destinations are
live. Each destination must preserve the exact source digest and the prior diagnostic
identity after path normalization; a destination already owned by the baseline, or any
duplicate, cycle, chain or path reuse, fails closed. `referenceFiles` are audit context
only and never authorize a violation identity replacement or a new baseline path.

The runner refuses a repository-wide `--fix`. `npm --prefix src/frontend run format:fix` fixes changed files only, and AST fixers must be idempotent. ESLint uses a content cache under ignored `.tmp/frontend-style/` so unchanged work is resumed rather than parsed repeatedly.

## Governance preservation

The pure receipt validator `tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs`
retains its literal `../fact-extractors/lib/canonicalize.mjs` dependency. The named
rule-registry exception applies only to that file and specifier. Other files,
other specifiers and equivalent path aliases retain parent-import rejection.
The pure dependency firewall remains mandatory and unchanged; this style mapping
does not authorize filesystem, execution, Markdown or DocClaim capabilities.

The policy pins the count, ID digest and definition digest of all existing `check:*` scripts. Generic lint is additive: a change that removes or rewrites an AEDS, security, privacy, accessibility, UI or performance command fails before linting. Every new generic rule has an owner, source scope and fixability in the rule registry.

External JSON keys, browser events, storage keys, Wasm exports, HTML attributes and CSS contracts are preserved as literals or mapping metadata while internal identifiers follow the language mapping. A formatter commit must never rename these surfaces.

## Mechanical migration

This rules commit contains config, fixtures, a transparent baseline and documentation only. After all active frontend feature branches land, mechanical formatting must be a separate commit. Naming and behavior fixes remain separate again. Only the reviewed pure-format SHA may then be appended to `.git-blame-ignore-revs`, followed by a regenerated empty baseline and strict-full proof.
