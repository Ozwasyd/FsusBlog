## Linked Issue

Refs #1975

Related to [#2258](https://github.com/Ozwasyd/FsusBlog/issues/2258), [#2263](https://github.com/Ozwasyd/FsusBlog/issues/2263) and [#2078](https://github.com/Ozwasyd/FsusBlog/issues/2078). No issue is accepted or closed by this source-preservation draft.

## Scope Summary

Expose the exact original FileService Observe/RecordAttachmentCleanupAsync module through root-owned IFileService. The current business binding uses the original completed-upload/session/AssetId/digest coordinates and checks the actual authenticated owner plus current-context guard before and after the original operation. Original scheduling/retention/state-change refusals remain visible; success does not become Recorded unless the original durable observation says so.

Consume exact implementation24309ab8868dd5f043178c4b3d3daa4f678a1b86 plus cancellation repair7940920e6575bd30837ba685d1b894b83abc03bc, only their original module and20-case test file, byte-for-byte. Existing native FileService and reference store dependencies match base69477c07466ff159e35b26d469dcdd2fefc13601; no duplicate store change or alternate SQL/queue. Repeated calls bind the actual original cleanup observation, preserve grace and refuse a stale native version. The original active-only native observer remains unchanged.

Implementation b48f78c8da31abe1d07059b36cb00386a27bdbf1; exact tested candidate cceae3d9c41823f069eb143f9043bb03de343f11. The branch retains the earlier source/dependency lineage including original assets, current draft/responsibility inputs and registered frame275; this increment is seven source/doc files, while the full master diff still requires coordinated ownership/conflict review. Observed master before work57886f75213bd22c0dd3a8e2586073bdbdd97778; no merge-ready or whole-chain claim.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: compatible

The earlier registered public frame275 lineage is retained; this increment adds server-only cleanup observation methods and changes no wire/ABI identity. Retained raw run artifacts are source-bound observations, not registered generated source or a replacement gate.

## Tests Run

- [ ] `./tools/test.sh fast` — not run; broad and held suites excluded.
- [x] Targeted backend tests: exact cceae3d9 standard project build/discovery exit0,28 nonempty names; two positive controls2/2 then20 original +8 business controls28/28,0skip,exit0. Commands/run IDs/counters are in artifacts/article-vault/cleanup-business-binding/cceae3d9c418/handoff.json.
- [ ] Targeted frontend checks: separate source-alias owner21/21 exists on1acd6f9; not run or merged into this backend candidate and not inherited.
- [x] Other: own three C# files canonical style0 violations; incremental commit contract and diff check pass. Original supplied module/test each fail one using-order check and remain byte-identical to7940920; these failures are not waived.

Both isolated PostgreSQL runs show actual original container create/start/kill/die/destroy, empty owned-container observations and no new native roots left. Original upload/session/PNG/native ledger facts are real. Current-context callback behavior is controlled in these composition tests; actual authenticated claims and original owner/token checks execute. SDK10.0.401, Node24.19.0; build1530 warning lines. No zero-warning/full-CI/native deletion/business receipt or product qualification. Supplier20/20 was not inherited; the current combined28 actually ran. Historical3a89 and61d native56 remain bound to their own SHAs.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

No rendered UI changed in this increment. Prior branch UI/product/browser acceptance is not inherited or claimed.

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable

- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: artifacts/article-vault/cleanup-business-binding/cceae3d9c418/external-naming.json

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

Stable method/ownership facts are in existing current `docs/api/contracts.md` and `docs/testing.md`. The retained artifact bundle binds past source/run observations and does not become a second current contract.

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

Two server-only interface methods use the original nested cleanup observation; no duplicate DTO or wire operation. The original canonical transaction/advisory locks and single delayed queue remain sole authority. No native deletion, reference removal, auth bypass or production DB change. A current-owner change after a real commit suppresses returned business facts, without pretending that committed scheduling rolled back. Actual UI grants, current context and transport remain with their original owners; a static incoming request DTO callback is insufficient browser authority.

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no performance, zero-warning or terminal migration qualification

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: bind original upload cleanup observations

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: source-preservation draft only; sole3735 composes the supplied four-reader scoped DI hunk and original authorized AEDS transport. No bootstrap file was edited here.
- Rollback: withdraw the source increment before activation; no production schema/data change. Preserve original delayed queue state and currentness refusals; no forged receipt or blind queue deletion.
- Deferred work: original module owner's two using-order fixes; actual host/DI/transport, full current rights/reference/receipt/product acceptance; original native/profile terminal migration composition and isolated apply/repeat/restore.
- Known limitations: #1975 partial, #1976 waiting; all16 issue gates retained. No full security/performance/held audit/native deletion or independent product qualification. Existing shared-document inventory failures remain unresolved.

## Notes For Reviewers

Draft title: `feat(backend): bind original upload cleanup observations`. Proposed label `release-note:internal`, target master, branch `codex/chain-1975-cleanup-business-binding`; only the authorized monitor may create or label it.

Not-applicable review items: no independent mechanical-format/naming migration, blame-ignore revision, registered generated source. The unchanged registered external naming surfaces are declared in the matching manifest, without waiving style failures. No new docs path or TODO/FIXME; stable docs use existing maintained files. Raw logs/TRX are source-bound observations, not a generated authority or qualified receipt. Formatter/checker ran only on own files; the two exclusive original files were checked read-only and their two failures preserved.

The full original module is supplied unchanged, including native validation cancellation restoration. IsSuccess, Abort bool, SchedulingRequired or a scheduling Task cannot substitute for actual Recorded. No store SQL copied. Original reference restoration cancels its sole queue. Business composition preserves original refusals and uses original locked observations for repeated operations.

Complete unapplied four-reader DI hunk: artifacts/article-vault/cleanup-business-binding/cceae3d9c418/di-owner3735.patch. Entire16 issue status: issue-status.md beside handoff.json. Separate frontend source1acd6f9 corrects this owner's public imports and lint, with actual21/21 through official source-alias; original private401 remains and host40 does not replace those controls. It is not part of the backend source candidate.

GitHub content API writes are paused: this complete body is supplied offline, not a created PR. Old draft3813 excludes these increments. No master push, merge, auto-merge, close, deployment, package publication or held/security/receipt/integrity audit. Later evidence/doc-only commits must not retag the cceae3d9 test runs.
