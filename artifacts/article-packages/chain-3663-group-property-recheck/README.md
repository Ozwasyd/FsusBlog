# Final group property observation recheck

Related to #2398, #2408, #2400 and #2410; all16 assigned issues remain OPEN/unaccepted.

Actual tested source: `983dd6eef8aab4eab5173d1abea3baf2b972a6b2`, branch
`codex/chain-3663-group-property-recheck`. Base/current bridge
`3d177f17fa34bdf322447f1ea917469d2c938869` is preserved unchanged on its
original branch. Latest master verified before this work:
`537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`; it was not broadly imported.
Later evidence commits do not retarget this compiled receipt.

The old finite planner could return an early article observation after later
article reads moved its snapshot/audit/definition/reconciliation or revoked its
permission. A test-only candidate `149fb214c28d6fe7a14cd18c7e707b921089b8dc`
strictly compiled, then all11new controls failed:8movement cases, revocation,
interrupted final read and a stable/repeated group control requiring actual
reauthorization. Raw11failed TRX is retained. An earlier new test fixture format
build failed3IDE0055 diagnostics; layout was fixed without weakening assertions.

The current planner constructs its finite candidate then reauthorizes every
held member via the existing sole `IArticlePropertyValueAuthority.ReadAsync`.
The reader rebinds the held component to actual read results and compares source
snapshot/factset/audit identity, current definition observations and
reconciliation. Any observed movement refuses the complete plan; canonical
access-denial and cancellation propagate. Stable/repeated groups perform3reads
per member per invocation and never call MutateAsync in controlled-port tests.
Existing per-article2read behavior is unchanged.

These are sequential observation checks. They cannot freeze the group or
prevent change after an individual final read. No atomic/export/transaction,
permission receipt, accepted full package schema, historical/draft/reference
producer or private source authority is added. RequirePropertyAuthority and
RequirePackageAuthority continue to refuse. The unit read data is controlled
fixture data, not an actual DB, signed-audit or live permission receipt.

[Current report](final-report.json): actual110whole-source closure from the
single tested candidate; SDK10.0.302, audit-enabled locked restore exit0,
strict compile0warnings/0errors;628/628controls passed,0failed/skipped.
Original571 and prior46controls remain;11new group controls are retained.
Three-file positive source style and current-policy new commit range exit0.
Docs lint remains FAIL:26inherited diagnostics, unwaived. Original held trust
and full matrices, SQL/audit persistence graph, Server-project strict
qualification, native/provider/HTTP/DB/product/independent acceptance were not
run and remain HOLD. No test or gate is promoted from source/component proof.

[Exclusive claims](exclusive-claims-preserved.json): all7released asset set and
version registry paths remain untouched. Both original worker tasks are active;
no result commit has been supplied or consumed and admission is not completion.
Historical rights CanonicalUrl projection stays original-reader-owned. No
historical slug/status/timestamp or operation authorization facts are invented.

This source branch changes4files versus its supplied base. Full master diff
also inherits the existing package/source closure; the supplied draft proposal
lists that complete scope and remains WIP. The coordinating parent alone
creates/edits PR content. No API content write, master push, merge, force-push,
issue close, auto-merge, deployment, shared lock update or cross-chain conflict
resolution occurred.

The archived harness retains actual original task paths and package locks.
Reproduction may rebind its whole-file prefix to the exact tested checkout in
a disposable private harness; that path change is not a new execution receipt.
Use the actual command/run/source records, original admission and resources.
