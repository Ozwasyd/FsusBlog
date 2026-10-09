# Scheduler diagnostic write correction evidence

Related to #3521 and #2248. Source commit: `8b24276f35c006a438d300eefe40c238d60dd54b`, branch `codex/chain-3521-scheduler-diagnostic-write`, base `e6efbce8ec875f92053af4ece5c82cc3044d7ed8`.

The exact runner Error is assigned to the failed result before attempting its diagnostic write. A failing diagnostic write is exposed through `diagnosticPublicationErrors` with its original Error identity. Failed diagnostic references remain absent. Existing terminal-vector publication error semantics and qualification policies remain unchanged.

The additive original control reproduces the bug on the old source: one executed, zero passed, one failed because the write Error replaced the runner Error. The final literal-name allowlist selects four ordinary original controls, all passed with zero skipped. Scoped mocks fail only the alpha diagnostic JSON write; the same original fixture and real attempt runner verify runner/write identities, absent references, blocked dependent, independent success and exactly-once cleanup. ESLint on the two changed source files, original static import inspection and commit-range checks passed under official Node 24.16.0.

The earlier writer-checkpoint file is preserved as a historical observation. It is superseded by the coordinator's explicit sole-writer assignment recorded in `final-source-handoff.json`; no second ownership approval was required.

The current fixture has 1,128 declared closed paths, and neither changed path belongs to that closure. Its bytes remain unchanged. This change does not confer live matrix/scheduler routing or runtime qualification. Full standard SOURCE and held substitution/race/replacement callbacks were NOT_RUN. #3521 remains blocked on independent current-epoch promotion; #3520 remains blocked by that prerequisite. The full per-issue ownership accounting is included.

Each command JSON records exact tested commit, UTC run identity, PID, argv, exit status and raw-log bytes/SHA-256. Its deterministic `.log.gz` archive preserves the actual bytes. `file-index.json` binds all other bundle files by byte count, SHA-256 and Git blob. Qualification is false throughout.
