# Canonical producer replay and remaining inputs

Source commit: `1767ca27ae78782ea3cf0d599a8149007b501683`.
Branch: `codex/chain-3663-group-property-recheck`.
Readonly fetched master: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`.

The official Node v24.16.0 binary matches the supplied SHA-256. Both original
producer entry points were run twice before committing and again on the published
source commit. Only their two output files changed. All 226 inventory entries,
their semantics/IDs/order, seven non-matrix source digests, 1399 protected inputs
and the complete independent index were preserved. The committed outputs reach
a fixed point. This is generated-source verification, not qualification.

The first published commit used an invalid `test-matrix` commit scope. Its actual
failed change-contract receipt is retained. The scope was corrected to `test`
with an exact remote lease; old/new trees are identical. The corrected commit
passes the trusted change-contract check. Old SHA receipts are not relabelled.

Normal matrix planning now fails at the original migration gate: it requires 225
producers and the unchanged complete inventory has 226. The original two-test
migration file has one failure for that contradiction and one passing
crossed-owner negative control. No matrix runtime callbacks were launched.
Publication binding and later gates were not reached; no manifest was hand-filled.

The existing original runtime controls remain bound to source
`74c0bdb904a1ec320cade56367da8a17e2b7b0c1`: required trust-window 31/31, selected
backend 813/813 and frontend 20/20. They were not rerun just to attach new generated
metadata. The prior original audited restore/build receipts retain their SQLite
audit warning, compilation warnings and unaccepted full gates.

The [module handoff](module-handoff.md) gives concrete readonly producer and AEDS
inputs, exclusive files, original APIs, checks and limits. The newly identified
minimal producer gap is a canonical server stable `SiteIdentity`; the real
server URL scope cannot satisfy the original actor context contract. No product
identity, permission observation, route or upstream receipt was fabricated.
Full schema/native qualification is not a blanket waiting condition for that
readonly module.

`final-report.json` records every owned issue's status. All sixteen execution
issues remain open and unaccepted; there are no tracking-only assignments.
The coordinator remains the sole PR/issue-body writer. No merge, master push,
deployment, issue closure or cross-chain conflict resolution was performed.
