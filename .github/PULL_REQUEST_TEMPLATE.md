## Linked Issue

Closes #

## Scope Summary

- <!-- Summarize the issue-scoped change. Do not hide unrelated work behind "also". -->

<!-- The gate requires a substantive summary and at least one checked Tests Run entry. -->

## Change Classification

- [ ] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [ ] External naming exception
- Contract impact: none / compatible / breaking

`Behavior change`, `Format-only`, and `Naming-only` are mutually exclusive. `Generated output`, `Public contract change`, and `External naming exception` are supplementary.

The gate reads fields only from their named section, rejects duplicate fields or headings hidden in fenced examples, and requires contract checkboxes to be checked. Record a not-applicable reason in `Notes For Reviewers` before checking that review item.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests:
- [ ] Targeted frontend checks:
- [ ] Other:

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

## Coding Convention

- [ ] C# mother-style mapping checked
- [ ] Formatter/linter run
- [ ] No tool default overrides repository style
- [ ] Mechanical formatting separated from logic
- [ ] `.git-blame-ignore-revs` updated when applicable

For a `Format-only` change, complete every field. The idempotence evidence must be one repository-relative `.json` path changed by this PR and conform to `fsusblog.format-idempotence-evidence.v1`. Use `none` for other changes.

- Formatter identity:
- Formatter version:
- Formatter command:
- Formatter idempotence evidence:
- Blame-ignore revision:

## External Naming Exception

For a checked `External naming exception`, point to one changed repository-relative JSON manifest using `fsusblog.external-naming-exceptions.v1`. Each entry binds one registered exception ID to its own changed paths and substantive reason; the union must exactly cover every changed registered naming surface. Use `none` otherwise.

- Exceptions manifest:

## Documentation / Intent

- [ ] Public API docs updated
- [ ] Ownership/security/performance intent updated
- [ ] Historical handoff archived or source-of-truth updated
- [ ] TODO/FIXME references valid issues

## Compatibility And Risk

- [ ] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed
- [ ] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [ ] External wire / ABI / database / third-party names preserved or explicitly adapted
- [ ] Public API impact reviewed
- [ ] AEDS frame / binary contract impact reviewed
- [ ] Database migration impact reviewed
- [ ] Security, auth, moderation, PoW, or privacy impact reviewed
- [ ] Docs updated or a reason is recorded below
- [ ] Known limitations updated if applicable

## Performance Claim

Use `none` and `Evidence path: none` unless the PR title type is `perf`. For S/M/R/C, the evidence path must be a changed repository-relative JSON manifest using `fsusblog.performance-claim-evidence.v1`; it binds the one perf commit SHA, claim level, `structural-only`/`measured` status, and each changed evidence file with its SHA-256 digest.

- Claim level: none / S / M / R / C
- Evidence path:
- Non-goals:

## Release Note

The matching `release-note:*` label selects the generated release category. GitHub renders the merged PR title as the release entry, so every included category requires `Summary` to exactly equal the summary portion of the PR title after `type(scope):`; `Category: none` instead requires `Summary: none`. Pure formatting, internal renames, and CI rearrangement must use `Internal/Tooling` or `none`.

- Audience: user-facing / internal / none
- Category: Added / Changed / Fixed / Security / Deprecated / Removed / Internal/Tooling / none
- Summary:

## Generated Output

For a checked `Generated output`, use `atomic` when source and output change together and bind them through `fsusblog.generated-output-binding.v1`. Use `post-merge-repair` only when `fsusblog.generated-output-repair-binding.v1` identifies the exact merged source revision and pull request that omitted the output, binds current source/generator/output digests, and passes canonical regeneration. Both modes require one changed repository-relative evidence manifest. An authenticated bot must identify itself exactly. Use `none` otherwise.

- Generation mode:
- Generator source:
- Generated outputs:
- Digest/evidence:
- Automation identity:

## Rollout / Rollback

- Rollout:
- Rollback:
- Deferred work:
- Known limitations:

## Notes For Reviewers

CODEOWNERS may request the configured maintainer for touched paths, but it does not replace this contract. Name the child issue actually closed and keep API, UI, database, security, generated, and mechanical changes separated unless the linked issue explicitly requires one atomic boundary.

The executable change-contract policy files are evaluated from the trusted base and cannot be replaced by the candidate PR that they judge. Until branch protection is available, their bootstrap update is an owner-controlled direct push followed by the post-push audit; do not describe that audit as preventive protection.
