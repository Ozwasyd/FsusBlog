## Linked Issue

Refs #3444

## Scope Summary

The ordinary GPU access-mode enum uses the singular word Access, but the trailing-s classifier rejected it and incorrectly accepted Flags Access. Append only Access to the sole acceptedSingularSuffixes directory; keep Accesses plural and all original Miss, flags, naming and declaration controls.

A separately selected --rebind-access-baseline-policy operation pins the already-merged b9c076e4 Miss policy/baseline and updates only policySha256. The original --rebind-baseline-policy remains Miss-only, pinned to its original b19 authority. Retain real baseline positive/refusal controls for both operations. GPU production source and behavior are untouched; the earlier #3650 leaf remains completed.

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
- [x] Targeted backend tests: complete original checker module plus two added tests, 103/103 zero skipped on actual source head 0b0a976aedc8e677e099765581eefd91cd70ba1f. Its checker, test, policy, baseline and current-doc blobs are identical at packaged head e6a273473b275dee0c4c2993ebd54e17a882ba33. Four focused groups passed before publication, including eight ordinary/Flags Access/Accesses/Miss controls and full real-baseline refusal coverage. Official SDK10.0.302 Access syntax build exit0, zero warnings/errors at0b0a; this is enum syntax coverage, not GPU execution.
- [ ] Targeted frontend checks:
- [x] Other: unchanged original execution-authority producer actually exited0 on0b0a. Exact e6 packaged candidate checks the byte-identical original GPU file from5b4305a9 with zero lexical findings using its real newly bound policy/baseline. Initial SOURCE failed because the isolated checkout lacked its configured frontend style toolchain; that actual failure is retained. Exact e6 SOURCE rerun after the documented locked tool installation exits0: three mandatory coordinators, both JS files zero diagnostics, current docs and lifecycle372, and five declared pure regression groups93/93 zero skipped. Its initial failure remains retained. No old Miss acceptance, GPU116 result, broader qualification or remote check is inherited.

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

- Exceptions manifest: artifacts/change-contract/gpu-access-csharp-external-naming.json

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
- Non-goals: No product runtime, API, ABI, debt waiver or policy promotion.

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: classify singular access enums precisely

## Generated Output

- Generator source: tools/dotnet/check-csharp-style.mjs, config/development/csharp-style-policy.json
- Generated outputs: config/development/csharp-style-baseline.json, tests/fixtures/test-matrix/release-final-execution-target-authority.json
- Digest/evidence: artifacts/change-contract/gpu-access-csharp-policy-binding.json
- Automation identity: none

## Rollout / Rollback

- Rollout: independent SOURCE review candidate only. This unreviewed capability is not accepted policy or a GPU runtime qualification.
- Rollback: revert the Access source and its ordinary bindings together, preserving the original Miss operation and closed acceptance.
- Deferred work: independent exact-source review, actual published PR metadata and broader compiled/native/runtime/release qualification.
- Known limitations: no new whole-repository CSharp, native GPU, security-held audit or full CI run is claimed. Current SOURCE receipts are exact-head local observations; prepared metadata is not a real PR. Full prior failures retain their actual tested identity.

## Notes For Reviewers

Exact source candidate e6a273473b275dee0c4c2993ebd54e17a882ba33 is on actual master base6e287562b3f861d3eb81dcb23f93e6243205abd8. Eight paths change: original checker/policy/baseline/test/current doc, two ordinary metadata manifests, and shared authority. The policy adds onlyAccess. The original baseline stays33violations/16files with schema, generatedFrom and all source/rule/violation digests byte-identical; only policySha256 changes through the pinned owner producer. No enum rename, Flags decoration, path/symbol exemption, threshold, runtime source, selection policy or protected history admission changes.

The unchanged canonical producer updates four content/index digest fields across two dependencies, preserving102targets/1128closure files and every other field: the owned CSharp checker and tools/test-inventory/discovery.mjs. Discovery source was already changed in the actual master base, is byte-identical between base and candidate, and had stale authority metadata; the original producer refreshed that inherited digest while generating the current complete closure. No Discovery implementation or generated JSON was hand-edited. The metadata commit's initial checker-only attribution was incomplete; this complete actual diff and binding-invariants.json correct it explicitly.

The legacy Miss real-baseline test keeps its exact Miss-only policy fixture and all existing refusal assertions. All original test IDs and assertions remain; the source fixture explicitly removes the laterAccess entry so the old operation's immutable policy is tested, and its excluded-path negative is based on that genuineMiss policy. NewAccess controls use a separate merged-authority baseline, cover corruption, mixed flags, cross-operation policies and idempotence, and do not turn a missing-baseline check into acceptance.

Public API, UI geometry, wire/ABI, database, auth, security and performance semantics are unchanged; corresponding checklist items were inspected and are not applicable. Current style docs were updated. No format-only migration or blame-ignore change applies. All prior #3650 acceptance and WIP GPU/native conclusions keep their original identity. No GitHubAPI content writes, PR creation, issue closure, merge, policy promotion or deployment were performed. Parent owns publication and new independent review.
