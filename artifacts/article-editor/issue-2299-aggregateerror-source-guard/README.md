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
Independent review of this guard correction is still pending.
