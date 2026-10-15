# AdvancedFilters repair static-log handoff

This is ordinary source-review evidence for draft PR #4401. It grants no runtime,
UX, release, receipt, authority or qualification acceptance. This publication only
copies existing raw logs and records their provenance; it runs no project checks
and changes no product source. All original failures and HOLDs remain.

The accepted repair source is `d77565ac949feb91c51336f561b3a1334981874e`, based on
the broken intake `d77b10b9a9a79f66b240587f34504492701e0f71`. The comparison base
is #4385 `b302f58a9aaee9f2399d9274157a478f3c2f78fb`. The actual local alias for
the recorded runs was `/workspace/FsusUI` at UI973
`41a127611fa3db054b7d5bca25aeb101f2401ef6`, with local consumption enabled.
Both source worktrees were clean for the committed-source checks. Physical alias
and CSS qualification remain unverified.

[handoff.json](handoff.json) records each original command, cwd, exit code,
execution source identity, original `/tmp` location, byte count, line count and
SHA-256. [SHA256SUMS](SHA256SUMS) covers every delivered raw log and both metadata
files. The `.log` originals were stored as `.txt` files so the repository does not
ignore them; their contents were copied without transformation, redaction,
normalization, truncation, filtering or deduplication. Every delivered log was
compared directly with its retained original.

The exit codes in the metadata are transcribed from the original tool results in
the same task history. Separate captured `.exit` files did not exist in `/tmp`;
none have been manufactured or presented as original output.

## Recorded results

| Original check | Base | Repaired source | Raw logs |
| --- | --- | --- | --- |
| Complete application typecheck | exit 2, 29 diagnostics | exit 2, same 29 diagnostics | [base](base-types.txt), [repaired](repaired-types.txt) |
| Complete frontend style | exit 1, 83,667 lines | exit 1, same 83,667 lines | [base](base-full-style.txt), [repaired](repaired-full-style.txt) |
| Original strict file check, ESLint and Stylelint | exit 0 | exit 0, zero violations | [base](base-strict.txt), [repaired](repaired-strict.txt) |
| FsusUI boundary | exit 1 | exit 1 | [base](base-boundary.txt), [repaired](repaired-boundary.txt) |
| Binary import boundary | exit 1 | exit 1 | [base](base-binary.txt), [repaired](repaired-binary.txt) |
| Code intent | exit 1 | exit 1 | [base](base-intent.txt), [repaired](repaired-intent.txt) |
| Document lifecycle, check mode | exit 1 | exit 1 | [base](base-lifecycle.txt), [repaired](repaired-lifecycle.txt) |
| Authoritative development docs | exit 1 | exit 1 | [base](base-authoritative.txt), [repaired](repaired-authoritative.txt) |

All eight base/repaired raw-log pairs are byte-identical. The full style failure
is retained; equality to a failing base is not a full-style pass. The original
broken intake's [strict reproduction](before-strict.txt) records all five added
errors, exit 1. The [repair commit-range check](repair-contract.txt) records exit 0.

The repaired strict run occurred before the repair source commit: Git HEAD was
still `d77b10b9a9a79f66b240587f34504492701e0f71`, while the target working-tree
blob was already `b0363a4e7a72aec3ab1483c48eb95a5a79afaedc`, exactly the blob
committed in the accepted repair. Its result binds those repaired source bytes;
it is not relabeled as a later commit execution. The other repaired complete
checks and the commit-range check ran at
`d77565ac949feb91c51336f561b3a1334981874e`.

The evidence publication commit is a later, evidence-only revision. No check was
rerun against that publication tree and no such execution is claimed.

## Preserved boundaries

The older `artifacts/article-editor/intake4374-static/` logs and
`artifacts/article-editor/issue-2295-intake4374.json` remain unchanged historical
evidence. They still describe the original intake, including its five new errors.
This directory supplies the previously local repair logs rather than replacing
that history.

The [design skill](../../../.agents/skills/fsusblog-design-conformance/SKILL.md)
and its evidence guidance distinguish static source controls from rendered and
independent UX acceptance. No new acceptance receipt is supplied here. Runtime,
tests, list/discovery, product/helper module execution, browser/render, native,
DB, frozen/authority and qualification work remain HOLD. The PR remains draft;
Ready, merge, issue closure and package publication are not authorized.
