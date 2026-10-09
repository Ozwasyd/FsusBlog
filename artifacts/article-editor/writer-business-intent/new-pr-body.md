## Linked Issue

Refs #2246

Related to [#2256](https://github.com/Ozwasyd/FsusBlog/issues/2256), [#1975](https://github.com/Ozwasyd/FsusBlog/issues/1975) and [#2283](https://github.com/Ozwasyd/FsusBlog/issues/2283). WIP source prerequisite; no issue acceptance or closure.

## Scope Summary

- Bind the supplied original business intent reader through the real Writer `authoringAttachmentRuntime.bindBusinessIntent(handle)`. The caller lends its actual `commitCreated/retry` handle; a closure matches intentRef and the original private adapter checks membership against the current public map. No second intent store, caller-supplied binding or receipt is introduced.
- Base d953e820094c32a2f11d5cd5cfaf269a369e4b06; branch `codex/chain-2246-writer-business-intent`; runtime-tested source 77231d5f23ca1fbf28f3c804f32fdadd1809a8d0. Exact supplied implementation ffacd1f062968a151ba4504b855eb65013a16c54 was imported as1ff423836 (five paths including original docs/tests). Its reader and21-control test remain byte-identical. Host changes own only the Writer composition and its ordinary dedicated controls.
- Current responsibility/draft HTTP/DI/Shared export remains with original3735; authorized resource/reference/cleanup authority remains absent and fail closed. verifyIntent is only intent verification, never complete asset authorization.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [ ] External naming exception
- Contract impact: none

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests: N/A; no backend change.
- [x] Targeted frontend checks: exact40 ordinary host controls passed,zero failed/skipped/todo at 77231d5f23ca1fbf28f3c804f32fdadd1809a8d0. Current-authorities16 + authoring-gates15 + actual-host9, original38/hooks preserved. Actual Node24.16.0/Vitest4.1.5/UI0e5c56050e8dd3e9ca3735078489d35a0bb6e3d2. Nonempty full-name/count admission and runtime rediscovery guarded before execution. First40 run39 PASS/1 FAIL retained: own added assertion wrongly expected a pending public rebase to stale. Fixture corrected to test original pending rebase and completed later-edit unknown; production guards unchanged.
- [x] Other: application types232→232,added0/removed0,both exit2; production source unchanged by final test-only correction. Host lint exit1: three original baseline digest errors. Supplied reader lint exit1: same three plus nine actual source findings (import order/group spacing,curly guards,optional chain); original producer1975 must correct these. Commit-contract and whitespace range d953..tested-source exit0.
- Producer21 controls BLOCKED at discovery: original test imports unresolvable `fsusui`, while the formal project alias maps `@ozwasyd/element-plus`. No list artifact produced; no21-control runtime invocation or substitute alias. Original source/test kept unchanged. No inherited producer pass and no browser/product/independent qualification.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [x] Accessibility and reduced-motion impact considered

## Coding Convention

- [x] C# mother-style mapping checked
- [ ] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable

- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: none

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

- Claim level: none
- Evidence path: none
- Non-goals: no performance, browser or independent UI/UX qualification claim.

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: bind Writer business verification to borrowed intent handles

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: source draft review only; no merge,deploy,auto-merge,issue closure or migration activation. GitHub content APIs remain paused/reserved to monitor.
- Rollback: revert incremental Writer binding and its controls; keep frozen d953/371/5a predecessors intact. Imported reader can be removed together with its explicit dependency if the consumer is withdrawn.
- Deferred work: producer1975 corrects its actual owning lint/test import and supplies exact verified source. Original3735 supplies actual SharedHTTP/DI; original ledger/resource owners supply real reference/cleanup authority. No reader facts become receiptRef or permission.
- Known limitations: this is a caller-handle factory for the existing verifyIntent port, not the missing complete business authority or all production image-input mounting. Local intent verification grants no asset/reference/cleanup permission. Global types/style baseline/frozen focus4/5/SOURCE and whole-chain terminal gates remain open.

## Notes For Reviewers

The actual public editor and original Writer port prove original handle ownership, detached verifier receiver safety, coordinate/cloned-handle refusal, caller cancellation, current pending rebase with old-request refusal, actual completion, later completed edit unknown, exact removal false and unmount withdrawal. API fixture responses remain ordinary host facts; no preview/history request or qualified asset projection is produced. First failure/admission-order guard logs are preserved task artifacts.

Imported source/tests remain exactly the supplied canonical producer files. Scope does not permit a private `fsusui` alias or silent editing of the producer tests/guards. Its21 controls have not run and nine actual owning lint errors remain; host40 is a distinct runtime suite, not a substitute producer receipt. Current backend readers have no supplied SharedHTTP/DI consumer. Existing history GET and server-draft response cannot substitute.

N/A review reasons: no C#,external HTTP/wire/ABI/AEDS/database/security/auth/PoW/privacy semantics,generated output,shared token,naming exception or mechanical-only revision changed. Public documentation imported from canonical producer describes its internal business port; host uses that original contract without new authority. No TODO/FIXME was added. Presentation is unchanged; mobile/dark/native/browser/a11y/performance/product/independent acceptance not run. Owning lint ran and failed as recorded, so its checkbox stays unchecked.

No GitHub content API write or PR creation occurred. Full payload is a source-branch handoff for the monitor; no closing issue keywords are used.
