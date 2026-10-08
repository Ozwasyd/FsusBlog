## Linked Issue

Refs #3444

## Scope Summary

The ordinary declaration classifier treated the first token after delegate as its type name. Valid internal delegate int Init(uint flags) and private delegate nint CopyDevices() therefore failed PascalCase on their return types, while a lowercase delegate returning System.Int32 could be missed.

Extract the actual identifier before the outer parameter list after its return type and optional generic type parameters. Preserve PascalCase refusals across native, generic/qualified, nullable/array, tuple, pointer/function-pointer, ref/readonly-ref, escaped and multiline declarations. No delegate/native-path exemption, GPU source/ABI rename, policy/baseline change or alteration of closed3650/live4035 is included.

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
- [x] Targeted backend tests: exact positive allowlist of15 ordinary checker tests executed at505ada2728740ffa21f25d452337a8279543f346, all15passed/zero skipped. This includes two new test groups with23 valid signatures,23 lowercase counterparts and four additional invalid names, plus unchanged type/record/Miss and attributed-parameter refusal controls. Exact checker/test/current-doc blobs are unchanged in the packaged candidate. Official SDK10.0.302 compiled45 original native declarations plus23 representative forms, exit0/zero warnings/errors; this is syntax coverage, not GPU runtime acceptance.
- [ ] Targeted frontend checks:
- [x] Other: original three native files from ec2187e4cb101257633beb4fda723992d0987b98 produce45 return-type false positives under the original c1 checker and zero findings under the candidate. Mutating only the45 names to lowercase in a disposable negative fixture retains45 type-name refusals. A separately disposable e6 Access plus exact delegate-only patch compatibility probe runs only four predeclared ordinary tests, all4passed; the real e6 and4035 heads remain untouched. The unmodified canonical authority producer exits0 at505ada272 and refreshes only checker content/index digests. Ordinary exact-candidate JS/doc/lifecycle and trusted metadata checks are listed in the portable handoff; complete module/SOURCE/global qualification and held audits are not claimed.

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

- Exceptions manifest: artifacts/change-contract/csharp-delegate-declaration-external-naming.json

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
- Summary: classify delegate declaration names precisely

## Generated Output

- Generator source: tools/dotnet/check-csharp-style.mjs
- Generated outputs: tests/fixtures/test-matrix/release-final-execution-target-authority.json
- Digest/evidence: artifacts/change-contract/csharp-delegate-declaration-generated-binding.json

## Rollout / Rollback

- Rollout: inspect the complete separate source candidate with an independent reviewer before admission. Preserve the Access PR4035 review head and original closed3650 acceptance.
- Rollback: revert the delegate classifier and its canonical execution binding together; no GPU runtime, ABI, policy or baseline rollback is involved.
- Known limitations: no full103 module, SOURCE/global aggregate, held audits, GPU/native/runtime or release qualification is claimed. Independent exact-diff review and published PR metadata remain with the coordinator.
- Deferred work: independent source review, current aggregate scope approval and GPU/runtime/release acceptance remain with their canonical owners.

## Notes For Reviewers

Exact separate candidate ba706b74c4d027b83c54a138ebf114e55fab992d starts at fetched master c1c6d0d4f676b434e94eebaeec2bc8ccd27a0131. Six files change: checker, test, current doc, original generated authority and two ordinary manifests. The policy and baseline are byte-identical to this base. The producer and independent execution index are untouched; only the two checker digest fields change, with102targets/1128closure files and every other value preserved.

The actual15-test/official-syntax/native-probe execution head is505ada2728740ffa21f25d452337a8279543f346; the packaged head has identical checker/test/current-doc input blobs. The original complete103/Access receipts belong to their original source and are not relabeled as a run of this distinct delegate candidate. The first two focused tests failed as expected before the fix; an intermediate multiline-header negative failure was fixed and retained. An initial native probe accidentally placed the fixture beneath a Git worktree and selected0files; that invalid probe and corrected standalone placement are retained rather than counted as acceptance. The real standalone probes actually selected three unchanged source files and produce45/0/45 findings.

All test selections were positively enumerated with expected counts before execution. No held Git-replacement/cohort/receipt/audit control was run or recreated, no aggregate was run and filtered afterward, and no GitHub content API write, policy promotion or merge was performed. Actual executed ordinary failures are retained as executed failures, not UNRUN. Full module/SOURCE/global/held audit and GPU/native/runtime qualification have not been executed for this candidate. The disposable Access compatibility probe is not a public combined candidate, promotion or cross-chain conflict-resolution phase. Closed3650 Miss and live4035 Access remain independent.

UI/public API/database/performance and production rollout checklist items are not applicable to this internal lexical checker correction. No GPU/native path or delegate identifier is exempted; actual invalid names still fail the ordinary type-name rule.

The final ordinary syntax correction includes two generic type-parameter attributes with less-than/greater-than constant comparisons. Their real lowercase failure was observed before repair and retained; the completed generic-group tracker then restores refusal. Official68 declarations and the exact allowed15 plus disposable4 ordinary tests were actually rerun because the source changed. Earlier21-case/66-declaration runs remain separately historical, not current results. The first prospective metadata gate rejected two incorrectly named template fields; those field labels are corrected without changing any acceptance rule, and the failed event/log are retained.
