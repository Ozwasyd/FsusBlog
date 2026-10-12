# Narrow original AggregateError source guard correction

Refs #2299. Parent independently reviewed actual4431 Root/Layout combination source
without a new functional finding, but its actual core guard FAILED. The old guard
allowed only new Error and misclassified the original session bridge's standard
AggregateError as an alternate host. before-core-guard-fail.json preserves that
actual exit1/failure/source hash output. The earlier statement that all AST guards
were green was inaccurate:16-file parsing and component AST passed, core guard did
not. No failure output or frozen authority/evidence is overwritten.

The constructor policy retains the existing Error allowance and otherwise permits
ONLY the bare unshadowed/unwritten AggregateError in the actual withCurrentSource
connector's nested retirement catch. It requires exactly [error, retirementError],
the original retirement-incomplete message, and the one original cause property.
Other constructors, aliases/global-member calls, local/import/parameter/binding
shadows, known constructor writes, different location/message/order/cause/options
and generic constructors remain denied. No broad new/identifier allowance and no
host/registry/authority check is removed. The original error causes are untouched.

The additive source-control CLI uses TypeScript AST only on the actual source and
23 inert source variants (1 positive/22 negative). It never imports/evaluates
product/control source, discovers tests, mounts an editor or executes native code.
Core/component guards and original strict tool lint now pass. All16 production
postimages and four closed Layout files are byte-unchanged. Last actual imported
program at4431 remains FAIL209; no production typecheck is rerun for this tool-only
change. All runtime/tests/list/qualification/frozen-authority holds remain UNRUN.
Independent review accepted the original standard aggregation allowance but found
seven new write bypasses in the8894 mutation check; the original23-control PASS
and original core FAIL above remain historical records.

## Bounded write-guard follow-up

The new before-write-policy-controls-fail.json records the unchanged8894 matcher
against seven additive static variants: object/array destructuring, direct global
alias assignment/defineProperty, Object.assign direct/alias and Reflect.set alias.
All original23 still pass; those seven are incorrectly allowed (actual exit1).
These are local reproductions of the parent-reported syntax classes, not a claim
that unprovided independent-review snippets were copied byte-for-byte.

The correction walks assignment targets through object/array patterns and defaults,
recognizes finite identifier aliases declared/assigned in this same module (including
chains and transparent TS/parenthesis wrappers), and checks direct Object.assign,
Object.defineProperty/defineProperties, Reflect.set/defineProperty member calls.
Alias sets deliberately over-approximate module scopes/order; they prove no runtime
identity. Within these explicit write forms, unresolved global property keys and
assign/descriptor sources or spreads fail closed. This is a bounded static guard
for the actual module, not a universal JS/global-mutation security proof.

All original constructor/authority prohibitions and exact original aggregation
shape/cause are retained. Eleven additional negative controls cover nested/default
patterns, alias chains/receivers and unknown keys/sources/spreads. The current
41-control source-only CLI (1 positive/40 negative), core/component guards and strict
repository tool lint pass. after-write-policy-controls-pass.json records the full
result. Controls collect every mismatch and exit1 rather than hiding later failures
behind the first throw; parse-invalid control input still throws.

No src file changes: all16 production postimages and four closed Layout sources
remain byte-unchanged from8894. No SCSS changed. Typecheck is not rerun for this
pure tooling change; last actual graph is FAIL209. No tests/list, browser, receipt,
race/security/privacy, IME/native or frozen authority/evidence refresh ran.
Independent review of this follow-up remains pending.
