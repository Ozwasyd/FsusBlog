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
- [x] Other: historical e6 observation only, not current integration acceptance: unchanged original execution-authority producer actually exited0 on0b0a. Exact e6 packaged candidate checks the byte-identical original GPU file from5b4305a9 with zero lexical findings using its real newly bound policy/baseline. Initial SOURCE failed because the isolated checkout lacked its configured frontend style toolchain; that actual failure is retained. Exact e6 SOURCE rerun after the documented locked tool installation exits0: three mandatory coordinators, both JS files zero diagnostics, current docs and lifecycle372, and five declared pure regression groups93/93 zero skipped. Its initial failure remains retained. No old Miss acceptance, GPU116 result, broader qualification or remote check is inherited.

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

PR4035 integration candidate is separate from the new delegate correction. Base c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131 was integrated textually clean into frozen e6a273473b275dee0c4c2993ebd54e17a882ba33. New frozen head 6bce29c5b6c3986e877bb92c3ab9ba5b763db5f4 replaces the stale ordinary binding through the original UNMODIFIED canonical authority producer and output-derived metadata. The producer actually exited0 at merge b1fe2f988310ab5790abee6e0f9fe4e6c25dca9d; its output was already byte-identical to the clean merged authority. Only the binding manifest needed a post-merge refresh: old7f97e75e739cb9c516fa455cd7dd8c3ddd5bd3c84f55e3bb8052ddc81bcb3bf6 to actualdad93142464ccff0eeafdb710d429f14e5ddb6489e213dc5444f6a136af65f5e. No hash was hand-filled, producer or independent index modified, or output edited.

Relative to current c1 master, the complete change still contains eight paths. The generated authority differs only in the checker contentDigest and indexDigest, with all other current-master values preserved. Earlier e6 versus its earlier base had additionally refreshed inherited stale Discovery fields; this is historical provenance, not the current-base diff. The current integration checker, tests, policy, baseline and current-doc blobs remain exactly identical to e6 and original103 core0b0a976aedc8e677e099765581eefd91cd70ba1f. The original 103 evidence retains its actual execution identity; no new103 run at this head is claimed.

The Access policy changes only its singular semantic-directory entry. Baseline remains33violations/16files with every byte except the authority-bound policySha256 preserved. The original Miss producer remains exact and closed3650 is not reopened. No delegate fix, GPU production source, ABI, exemption, threshold, selection policy or protected-history rule is changed by this integration.

Only explicitly enumerated ordinary source/metadata checks are run for this integration. A new SOURCE or complete aggregate is blocked under the held-control scope instruction; original historical SOURCE and103 logs must not be relabeled as current aggregate acceptance. No held audit or Git-replacement/cohort/receipt control is run. SAME independent reviewer must assess the complete new closure. This source head and prospective public metadata do not qualify or promote the Access policy, authorize merge, or satisfy GPU/native/runtime/release gates. No GitHub content API write is performed.

The initial ordinary range check rejected the default merge header. Before publication, the isolated integration commit messages were corrected to the required conventional form. The actual producer checkpoint remains published on its own execution-checkpoint branch; its complete input tree equals the corrected merge tree. Earlier source checks remain recorded at their actual4c7a84202d35ab3b4ae3c501e120d05b1f61c5ac execution head, whose complete tree equals the corrected candidate. No observation is relabeled and no Git replacement ref or held control was used.
