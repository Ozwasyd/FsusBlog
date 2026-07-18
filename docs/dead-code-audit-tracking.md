# Dead-code audit tracking

Issue [#1015](https://github.com/Ozwasyd/FsusBlog/issues/1015) is the tracking entry for the 2026-07-09 dead-code audit and child issues #998–#1014. The durable machine-readable index is `docs/planning/dead-code-audit-index.json`.

This document does not recreate the claimed 85-row source report. `artifacts/dead-code-audit-report.md` is absent from the workspace, explicitly ignored by `.gitignore`, and was not found by the 2026-07-11 GitHub code search recorded during implementation. Without those rows, inventing individual findings, confidence labels, or grep evidence would be false evidence.

## Three evidence layers

The index keeps three kinds of evidence separate:

| Layer | Meaning | What it does not prove |
| --- | --- | --- |
| GitHub historical evidence | A child issue state, owner completion comment, and commit identifiers observed through `gh issue view --comments` on 2026-07-11. | It does not prove the current shared worktree builds or still passes the historical commands. |
| Current worktree evidence | Paths that exist in the current repository and can be inspected by the later verification phase. Every entry currently says `verificationStatus=not-run`. | Path presence is not a test result and is not acceptance proof. |
| Source audit report | The original per-finding report named by #1015. | It is missing and ignored, so the 85/44/41 counts remain issue-body claims rather than a current recount. |

`currentWorktreeValidation.status` is therefore `not-run`, with no commands and no validation timestamp. Historical issue comments must never be copied into this field.

## Indexed status

The live issue reads performed for this implementation found:

- #998–#1005: eight Sprint 0 issues, all observed closed with completion comments.
- #1006–#1012: seven Sprint 1 issues, all observed closed with completion comments.
- #1013–#1014: two Sprint 2+ issues, both observed open with no comments and milestone evidence still required.

The #1015 headings say “Sprint 0 — 9” and “Sprint 1 — 5”, but their tables contain eight and seven entries. The actual table split is 8/7/2 and still totals 17. The index preserves both the declared headings and actual rows so a later cleanup cannot silently rewrite the discrepancy.

The claimed finding total remains 85 = 44 CONFIRMED + 41 PLAUSIBLE. `currentRecountStatus=not-run` stays mandatory until the source report is recovered or reconstructed from reviewable primary evidence.

## Stage gates

\#1013 and #1014 are fail-closed. Code deletion or local tests alone cannot satisfy their production milestones.

For #1013, completion requires evidence for all six triggers:

1. the upload pipeline has completed at least one release cycle with no legacy root cleanup;
2. `site_subscription.hash_version='sha256-legacy'` count is zero after migration;
3. the article content-finalize migration is applied in every environment;
4. the legacy plain-cookie read window is closed;
5. one full AOT rebuild leaves no legacy sidecar hashes;
6. the legacy public-artifact schema step has executed.

For #1014, completion requires evidence for the same four trigger ids stored in
`docs/planning/dead-code-audit-index.json`:

1. `physical-account-subject-expand-backfill-verified`: an executed backend
   integration result proving the additive Expand descriptor, resumable canonical
   Backfill, format constraint, and permanent startup invariant;
2. `production-account-subject-invalid-count-zero`: a production observation with
   environment, UTC timestamp, exact null/`btrim`/malformed query, and result `0`;
3. `retired-identity-reset-surface-and-control-absent`: a current repository residue
   report that distinguishes historical audit records from live code, plus a deployed
   operations-configuration inventory proving the retired control is absent;
4. `full-issue-verification-complete`: the requested backend and Playwright run
   summaries, including the direct fail-closed identity-boundary tests.

The retired destructive reset is not a prerequisite action and must not be recreated
to manufacture completion evidence. Historical reset-completion evidence is neither
required nor interchangeable with the four current non-destructive cutover triggers.

Each trigger must set `satisfied=true` and list at least one existing evidence path. A stage cannot be `ready` or `complete` while any required trigger is false or lacks evidence. A stage cannot be `complete` while its GitHub snapshot is still open.

## Checker contract

The offline checker is:

```bash
node tools/governance/check-dead-code-audit-index.mjs
```

The default mode checks governance truthfulness: schema, 85/44/41 arithmetic, exact ordered issue range #998–#1014, actual 8/7/2 split, historical comment provenance, current path existence, source-report availability, and stage-gate consistency. A well-formed blocked tracker can pass this mode; the report still contains `completionReady=false` and neutral `notices` for every blocker while reserving `warnings` for actionable checker anomalies.

Final closure must use:

```bash
node tools/governance/check-dead-code-audit-index.mjs --require-complete
```

That mode additionally requires:

- a checked-in complete source report with a matching SHA-256;
- current worktree validation marked `passed`, with non-empty executed commands and a timestamp;
- #1013 and #1014 closed with every trigger evidenced.

The checker accumulates every error and has no maximum-error option or early truncation. It does not contact GitHub; live state changes must be read deliberately and then recorded with a new observation timestamp.

Unit coverage is authored in `tests/tools/dead-code-audit-index.test.mjs`. It covers canonical blocked state, `--require-complete`, issue-range/count drift, historical/current evidence conflation, false stage completion, false source-report completion, and multi-error aggregation.

## Post-audit source-lock and privacy residue

Issue #1050 is a follow-on test-governance cleanup, not a new claim about the missing 85-row report. Its three mixed backend suites were split into log-cleanup database/worker, upload queue/worker, and HumanRead submission/request-binding/persistence owners. `tools/check-historical-residue.sh` now fails if the retired `LogCleanupServiceTests`, `UploadSessionCleanupQueueTests`, or `HumanReadProofServiceTests` classes return, or if any #1050 behavior owner starts reading repository source through `BackendTestPaths`, `File.ReadAllText*`, `File.ReadAllLines*`, `File.OpenText`, or the retired source-reader helpers.

The same checker keeps HumanRead persistence anonymous by rejecting visit-log user binding and raw visit-IP persistence across the runtime contract paths. `tests/frontend/checks/static/check-historical-residue-fixture.mjs` owns negative fixtures for the retired mixed suite, a source reader inside a replacement behavior suite, user binding, and raw IP, plus a safe replacement-suite fixture. These static rules prevent implementation-string tests from returning; they do not replace the PostgreSQL, worker, queue, proof, privacy, coverage, mutation, timing, or production-fresh evidence required by #1050.

## Maintenance workflow

1. Read the affected GitHub issue body and all comments.
2. Update only the issue’s `githubHistoricalEvidence`, preserving the observation timestamp and evidence kind.
3. Add current worktree paths separately; do not mark them passed until the current commands actually run.
4. For stage issues, attach concrete evidence paths to every trigger before changing its status.
5. If the original report is recovered, remove its ignore rule, review all 85 rows, check it in, record `sha256:<digest>`, and change availability to `checked-in-complete`.
6. Run the default checker during static governance and `--require-complete` only for final closure.

## Protected non-goals

This tracking issue does not authorize new cleanup in migration, identity, AEDS, AOT compatibility, or runtime fallback code. In particular:

- database migration sequences and step numbering remain owned by their migration issues;
- AEDS retired-frame rejection and v3 protocol reservations remain intact;
- `MatchesLegacyBase64UrlPayloadHash` and other milestone-gated compatibility code are only removed by #1013 after its evidence exists;
- legacy identity reset and subject-hash cleanup remain owned by #1014;
- the five article route registrations called out by the original audit are not removed from this tracker.

## Validation status

No build, test, lint, restore, syntax, profile, checker, or runtime command was executed while authoring #1015 artifacts. The files are implementation and future-verification code only; they are not current pass evidence.
