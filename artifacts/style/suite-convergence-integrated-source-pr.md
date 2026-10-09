## Linked Issue

Refs #3593



## Scope Summary

- Preserve the original suite-convergence test style migration, integrate the exact canonical SOURCE blame-ignore port with the authorized import union, and regenerate its actual execution closure through the unchanged producer.



## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [ ] Public contract change
- [x] External naming exception
- Contract impact: none

`Behavior change`, `Format-only`, and `Naming-only` are mutually exclusive. `Generated output`, `Public contract change`, and `External naming exception` are supplementary.

The gate reads fields only from their named section, rejects duplicate fields or headings hidden in fenced examples, and requires contract checkboxes to be checked. Record a not-applicable reason in `Notes For Reviewers` before checking that review item.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests:
- [x] Targeted frontend checks: strict leaf and original SOURCE JavaScript style, zero violations.
- [x] Other: current audited positive ordinary controls7 and SOURCE routing6; historical long-suite evidence remains separately bound to its original tested commit.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable

For a `Format-only` change, complete every field. The idempotence evidence must be one repository-relative `.json` path changed by this PR and conform to `fsusblog.format-idempotence-evidence.v1`. Use `none` for other changes.

- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

For a checked `External naming exception`, point to one changed repository-relative JSON manifest using `fsusblog.external-naming-exceptions.v1`. Each entry binds one registered exception ID to its own changed paths and substantive reason; the union must exactly cover every changed registered naming surface. A missing manifest already named by an authoritative merged PR may instead use `fsusblog.post-merge-external-naming-evidence-repair.v1`; that strict repair binds immutable merge history, unchanged source blob/revision identity, the registered surface, and the exact missing artifact without changing the source again. Use `none` otherwise.

- Exceptions manifest: artifacts/change-contract/suite-convergence-leaf-external-naming.json

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed
- [x] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [x] External wire / ABI / database / third-party names preserved or explicitly adapted
- [x] Public API impact reviewed
- [x] AEDS frame / binary contract impact reviewed
- [x] Database migration impact reviewed
- [x] Security, auth, moderation, PoW, or privacy impact reviewed
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

## Performance Claim

Use `none` and `Evidence path: none` unless the PR title type is `perf`. For S/M/R/C, the evidence path must be a changed repository-relative JSON manifest using `fsusblog.performance-claim-evidence.v1`; it binds the one perf commit SHA, claim level, `structural-only`/`measured` status, and each changed evidence file with its SHA-256 digest.

- Claim level: none
- Evidence path: none
- Non-goals: runtime qualification and trusted policy promotion

## Release Note

The matching `release-note:*` label selects the generated release category. GitHub renders the merged PR title as the release entry, so every included category requires `Summary` to exactly equal the summary portion of the PR title after `type(scope):`; `Category: none` instead requires `Summary: none`. Pure formatting, internal renames, and CI rearrangement must use `Internal/Tooling` or `none`.

- Audience: internal
- Category: Internal/Tooling
- Summary: integrate exact suite convergence source boundary

## Generated Output

For a checked `Generated output`, bind the output to its source through one repository-relative `.json` manifest path changed by this PR. Normal atomic source/output changes use `fsusblog.generated-output-binding.v1`. A generated-only repair for a source omission already merged into the PR base uses `fsusblog.post-merge-generated-output-repair.v1`; it must name one trusted producer and leave its source and generator unchanged. A trusted ordered multi-producer repair uses `fsusblog.post-merge-generated-output-repair-dag.v2` and its registry-owned canonical manifest path. An authenticated bot must identify itself exactly. Use `none` otherwise.

- Generator source: tools/test/correctness-attempt-migration.mjs, config/testing/release-final-execution-authority-index.json, tests/tools/blame-ignore-source.test.mjs, tests/tools/pr-impact-plan.test.mjs, tools/test-matrix/blame-ignore-source.mjs, tools/test-matrix/pr-impact-plan.mjs, tools/test-matrix/source-governance.mjs
- Generated outputs: tests/fixtures/test-matrix/release-final-execution-target-authority.json
- Digest/evidence: artifacts/change-contract/correctness-current-migration-execution-binding.json
- Automation identity: none

## Rollout / Rollback

- Rollout: independent source review only; no merge or deployment
- Rollback: revert only the reviewed source increments while retaining immutable historical evidence
- Deferred work: catalog current-epoch historical admission, original QPS BEFORE authority, complete SOURCE held callback stage, same independent reviewer and full qualification
- Known limitations: original two QPS refusals remain; full SOURCE and held Git/receipt/cohort/lease/native audits were not executed; local prepared metadata is not an actual PR receipt

## Notes For Reviewers

CODEOWNERS may request the configured maintainer for touched paths, but it does not replace this contract. Name the child issue actually closed and keep API, UI, database, security, generated, and mechanical changes separated unless the linked issue explicitly requires one atomic boundary.

The executable change-contract policy files are evaluated from the trusted base and cannot be replaced by the candidate PR that they judge. Until branch protection is available, their bootstrap update is an owner-controlled direct push followed by the post-push audit; do not describe that audit as preventive protection.

Prepared local review metadata only; no PR has been created or edited. C#, public API, wire/ABI, database, security, UI and documentation changes are not applicable to this sixteen-path boundary. Existing format-only parent diff and later blame registration are independently preserved; the aggregate also contains separate syntax and canonical generated capability. The ordinary migration-to-authority binding was adapted from the parent-supplied existing schema and independently regenerated actual output. The catalog input/history boundary remains separately open; no generated-only repair qualification or supplier receipt was copied.

Current base be7c53d99b64342925ca63d061bacde34d22ba4c. Exact canonical3659 input0a88beb347d1941d140898cfa39c49285841e2d5 is consumed through only the authorized import union; all current fs/path and repository-root routing logic is preserved. Canonical3534 finite parser input remains unchanged. Own producer ran twice identically, with1139 closure rows and102 original target identities. No full SOURCE receipt or held callback run is claimed. Frozen cdc7 and its historical evidence remain unchanged.
