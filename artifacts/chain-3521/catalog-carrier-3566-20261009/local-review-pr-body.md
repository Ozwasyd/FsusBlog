## Linked Issue

Refs #3521



## Scope Summary

- Regenerate the current digest-only correctness catalog with its original producer; preserve all 226 complete records and eight real source inputs.


## Change Classification

- [ ] Behavior change
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
- [ ] Targeted frontend checks:
- [x] Other: canonical catalog --write and current --check; generated-only admission remains blocked.

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

- Exceptions manifest: artifacts/change-contract/chain-3521-catalog-carrier-3566-external-naming.json

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
- Non-goals: runtime or history qualification

## Release Note

The matching `release-note:*` label selects the generated release category. GitHub renders the merged PR title as the release entry, so every included category requires `Summary` to exactly equal the summary portion of the PR title after `type(scope):`; `Category: none` instead requires `Summary: none`. Pure formatting, internal renames, and CI rearrangement must use `Internal/Tooling` or `none`.

- Audience: internal
- Category: Internal/Tooling
- Summary: regenerate the current digest-only correctness catalog carrier

## Generated Output

For a checked `Generated output`, bind the output to its source through one repository-relative `.json` manifest path changed by this PR. Normal atomic source/output changes use `fsusblog.generated-output-binding.v1`. A generated-only repair for a source omission already merged into the PR base uses `fsusblog.post-merge-generated-output-repair.v1`; it must name one trusted producer and leave its source and generator unchanged. A trusted ordered multi-producer repair uses `fsusblog.post-merge-generated-output-repair-dag.v2` and its registry-owned canonical manifest path. An authenticated bot must identify itself exactly. Use `none` otherwise.

- Generator source: config/testing/release-reliability-scenario-catalog.json, config/testing/replay-qualification-producers.json, config/testing/test-execution-envelope-applicability.json, tests/matrix.yml, tools/test-matrix/production-fresh-run-bound-outputs.mjs, tools/test/attempt-runner.mjs, tools/test/temporal-context-contract.mjs, tools/test/temporal-context.mjs
- Generated outputs: config/testing/correctness-attempt-producers.json
- Digest/evidence: artifacts/change-contract/chain-3521-catalog-carrier-3566-generated-binding.json
- Automation identity: none

## Rollout / Rollback

- Rollout: source review only; no deployment
- Rollback: revert this isolated catalog output increment
- Deferred work: trusted current source epoch and real isolated adapter qualification
- Known limitations: ordinary unchanged-input refusal; trusted v2 registry lists seven inputs while the producer has eight; actual adapter refuses system ownership in this environment

## Notes For Reviewers

CODEOWNERS may request the configured maintainer for touched paths, but it does not replace this contract. Name the child issue actually closed and keep API, UI, database, security, generated, and mechanical changes separated unless the linked issue explicitly requires one atomic boundary.

The executable change-contract policy files are evaluated from the trusted base and cannot be replaced by the candidate PR that they judge. Until branch protection is available, their bootstrap update is an owner-controlled direct push followed by the post-push audit; do not describe that audit as preventive protection.

Review scope is generated catalog bytes only. Product/API/UI/database/security/C# formatting items are not applicable; no runtime source is changed. This is a local review draft, not a GitHub event or published PR acceptance.

The formatter/linter review uses the original JSON producer and its fixed-point check. No C#, formatter override, public API, TODO, or runtime behavior is changed; those checklist items are reviewed as not applicable. The existing json-wire-key exception is declared without adding a policy exception. Current source/input refusal and real adapter ownership refusal remain recorded gates.
