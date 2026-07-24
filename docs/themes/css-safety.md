# Theme CSS safety and asset budgets

Theme packages are declarative input, but CSS still has global rendering,
network and denial-of-service effects. `ThemeCssSafetyScanner` therefore runs
before installation and again from the stored content-addressed archive before
every activation. A parser ambiguity, unknown asset reference, invalid UTF-8,
budget overflow or rule violation blocks the operation; the scanner never
downgrades a violation to a warning.

## Stable scope and resource rules

Selectors may begin only with the exact package theme id in one of these
boundaries:

```css
:root[data-theme="fsusblog.theme.example"]
[data-theme="fsusblog.theme.example"] .fsus-theme-scope
[data-theme="fsusblog.theme.example"] .fsus-prose
[data-theme="fsusblog.theme.example"] .fsus-code-block
```

Bare `html`, `body`, `div`, `span` and universal selectors are rejected.
Element Plus `.el-*` internals are not a theme API. `@import`, absolute,
protocol-relative, data/script-like and unknown `url()` values are rejected.
A relative URL is accepted only when it resolves to an asset declared by the
same manifest and present in the same archive.

The scanner also rejects fixed full-viewport overlays, numeric z-index values
outside `[-100, 100]`, blur above 16 px, infinite animation, and transitions
over `all`, `top`, `left`, `width` or `height`. Animation and transition
durations are aggregated against the manifest motion budget. CSS, aggregate
assets, preview, selector count/depth and `!important` count are each checked
against both the declared limit and the immutable platform ceiling.

This v1 scanner is intentionally conservative and is not a general CSS parser.
Unsupported or ambiguous constructs must be rewritten into the supported
declarative subset rather than allowlisted after a failed scan.

## Machine evidence and release consumption

Every successful scan exposes a
`fsusblog.theme.css-safety.v1` record with the exact theme id, measured budgets,
empty violations and string warnings. Failed scans return the same record as
`blocked` through `ThemePackageException.CssSafetyEvidence`, so callers can
explain the rejection without treating it as acceptance.

Fresh release execution writes the successful record to:

```text
.tmp/release-evidence/theme-css-safety-summary.json
```

`tools/release/theme-css-safety-evidence.mjs` rejects blocked, malformed,
symlinked or over-platform-budget records. The evidence collector copies only
a record that passes that consumer, and `release-final` requires the copied
record. A source fixture, historical scan or file with a hand-edited `status`
cannot replace a fresh scan of the release candidate.

## Risk and no-restart fallback

The main compatibility risk is a previously tolerated global selector or
resource URL becoming invalid. The safe rollback is to disable the affected
activation scope or atomically select the last installed package that still
passes its activation rescan. This changes registry activation without a
service restart. Operators must not bypass the scanner, loosen platform
ceilings, restore a missing archive, or serve unsafe CSS as a fallback.

Theme activation does not change HTTP contracts. Anonymous and logged-in
public readers, admin views, notification streams and binary endpoints retain
their existing authentication and transport behavior; a failed theme scan
leaves their currently active CSS and all request paths unchanged.
