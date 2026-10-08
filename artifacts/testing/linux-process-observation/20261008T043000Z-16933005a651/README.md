# Published evidence head revalidation

Informational historical observations for #3620; no runtime qualification.
Tested exact evidence-only head: `16933005a65162e6cce03f817c38757f5a92bb99`.

The same seven original test owners from the previous record ran without source
changes. The first run returned exit 1: **67 passed, one failed, zero skipped**.
The reparented child writer test in `production-build-owner-identity.test.mjs:209`
attempted `stat` on its output before the file existed and reported ENOENT.
The test uses a fixed wrapper-exit delay before reading the writer output; this
observation is consistent with an intermittent readiness race, not proof of a
collector regression. No assertion, timing or test source was changed.

An unchanged full retry returned exit 0: **68 passed, zero failed/skipped**.
An independent owner-file retry returned exit 0: **10 passed, zero failed/skipped**.
The negative first run is preserved; the repetitions do not erase it or establish
native execution/finalizer qualification.

The PR contract was rerun after correcting the build title's classification.
The previous transient `build title cannot claim Behavior change` error was a
PR-description error, now removed. Protected unchanged-source generated bindings
and external-naming exact-scope failures remain exit 1. No owner manifest or
admission policy was changed. Missing remote checks are not a blocker.

Commands were the unchanged seven-owner controls command in the prior record,
`node --test tests/tools/production-build-owner-identity.test.mjs`, and the original
change-contract checker on actual PR API metadata. Node was official 24.16.0.
All complete logs and raw/compressed digests are in [observations](observations.json).
The later exact canonical compiler handoff is recorded separately.
