# Frontend style enforcement

`docs/development/coding-conventions.md` is the cross-language authority. This document records the executable TypeScript, JavaScript, Vue and CSS mapping implemented by ESLint and Stylelint; it does not replace the authority or any AEDS, security, privacy, accessibility, motion, UI or performance gate.

## AST toolchain

The authoritative frontend formatter is the AST-aware pair in `tools/frontend/style-toolchain/`: ESLint 10 with typescript-eslint Project Service and eslint-plugin-vue, plus Stylelint 17 with Vue/SCSS custom syntaxes. Prettier is intentionally not an authority because it cannot preserve the repository's Allman brace contract. The toolchain has an independent lockfile so linting never needs GitHub Packages or a published FsusUI build.

The covered source sets are:

- `src/frontend/src/**` for TypeScript, JavaScript, Vue, CSS and SCSS;
- `src/frontend/wasm/web/**` for the TypeScript/JavaScript Wasm adapter;
- `src/frontend/scripts/**` and hand-written `src/frontend/public/**/*.js` to preserve the previous JavaScript security scope;
- `tools/**/*.mjs` and `tests/**/*.mjs` for Node tooling;
- generated, public artifacts, vendored dependencies, minified files and intentional fixture directories only through explicit policy exclusions.

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

Regenerate a reviewed baseline without changing source:

```bash
node tools/frontend/check-frontend-style.mjs --mode full --update-baseline
```

The updater remains monotonic by default: it rejects a new path, a violation-count increase or an equal-count identity change. A convergence change may authorize only the exact residual rejection set with `--reviewed-baseline-classification <path>`. The classification is a closed `fsusblog.frontend-style-baseline-classification.v1` document and must bind every path to its exact source digest, violation digest, rule counts, ancestor owner commit, review issue, reason and `source-content-change` terminal condition. Missing, extra, stale, wildcard, reversed-owner and non-owner entries fail closed.

Reviewed classification is limited to existing module ownership: exact parent-directory imports in `tests/**` or `tools/**`, and necessary retained fixture symbols in `tests/**` or `tools/test-fixtures/**`. It is accepted only during `--update-baseline`; it does not suppress changed-file or `strict-full` findings, cannot authorize any other semantic rule, and cannot be reused after source content changes.

The runner refuses a repository-wide `--fix`. `npm --prefix src/frontend run format:fix` fixes changed files only, and AST fixers must be idempotent. ESLint uses a content cache under ignored `.tmp/frontend-style/` so unchanged work is resumed rather than parsed repeatedly.

## Governance preservation

The policy pins the count, ID digest and definition digest of all existing `check:*` scripts. Generic lint is additive: a change that removes or rewrites an AEDS, security, privacy, accessibility, UI or performance command fails before linting. Every new generic rule has an owner, source scope and fixability in the rule registry.

External JSON keys, browser events, storage keys, Wasm exports, HTML attributes and CSS contracts are preserved as literals or mapping metadata while internal identifiers follow the language mapping. A formatter commit must never rename these surfaces.

## Mechanical migration

This rules commit contains config, fixtures, a transparent baseline and documentation only. After all active frontend feature branches land, mechanical formatting must be a separate commit. Naming and behavior fixes remain separate again. Only the reviewed pure-format SHA may then be appended to `.git-blame-ignore-revs`, followed by a regenerated empty baseline and strict-full proof.
