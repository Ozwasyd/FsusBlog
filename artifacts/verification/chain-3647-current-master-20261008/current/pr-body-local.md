## Linked Issue

Refs #3647

## Scope Summary

Correct one XML statement for a missing ban authority fact: it supplies no fact and the existing local reread may observe a concurrent applied fact. Exact17 historical declaration docs were already merged by PR3694. This candidate is a direct child of current fetched master6e287562b3f861d3eb81dcb23f93e6243205abd8, with only one XML comment correction and the original required naming metadata. No staged prerequisite, test/oracle, runtime token, Project XML, lock or policy change.

## Change Classification

- [ ] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [x] External naming exception
- Contract impact: none

## Tests Run

- [ ] `./tools/test.sh fast`
- [x] Targeted backend tests: fresh current candidate b653640c86d214283f6865bcfc4a47571764686d: unchanged original BanStateProjection/Convergence15/15, zero failed/skipped. Real unmodified test-project and product build, locked restore with NuGetAudit=true pass. SQLite NU1903 and analyzer warnings remain visible. Supplementary exact-product-assembly8scenario probe passes, including missing authority with concurrent Apply, stale/conflict refusals, cancellation, cleanup and repeated loads; it does not replace original tests or qualification.
- [ ] Targeted frontend checks: no frontend change.
- [x] Other: current original source-integration matrix, style, docs/lifecycle, trusted commit range, complete noncomment tokens/signatures/AST/XML-stripped equality, exact17 roster coverage and negative controls pass. Scope and intent proofs are attached. SDK10.0.401/Node24.16.0. Local metadata diagnostic does not confer GitHub PR admission.

## UI Evidence

- [x] Screenshots or video attached for UI changes
- [x] Mobile layout checked
- [x] Dark mode checked
- [x] Accessibility and reduced-motion impact considered

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

- Exceptions manifest: artifacts/change-contract/ban-projection-docs-external-naming.json

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
- Non-goals: runtime policy, heap quota, full/native qualification or deployment

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: clarify missing ban authority documentation

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: independent source review handoff; retain issue OPEN. No merge or deploy.
- Rollback: revert inaccurate owned XML wording through normal review; existing tests and source remain intact.
- Deferred work: independent security/domain review, original full qualification, later separately authorized merge and current-master recheck.
- Known limitations: source stage explicitly has qualificationEligible=false; historical merge-footer and global RED receipts remain. PostgreSQL/Redis cross-node convergence and full/native/runtime qualification are not established by263 tests.

## Notes For Reviewers

Related to #3647. Review only exact master base6e287562b3f861d3eb81dcb23f93e6243205abd8 to candidate b653640c86d214283f6865bcfc4a47571764686d. Current master advanced from requested5798707d only by the PDF implementation; the owned file and project/props/lock graph are identical between those bases. No4fde hydration-read-count or other test changes are imported. The sole source delta replaces “remains unknown” with the actual missing-fact/local-reread semantics. Source trace: LoadFromSourceAsync returns Read(subjectHash) for null loads, and Read reopens local entries. No admission or authority-readiness guarantee is added.

The existing native naming registry requires external naming metadata for this changed C# surface even when runtime tokens are unchanged. The ordinary manifest contains no policy change. Exact17 coverage is keyed by historical node and complete token identity, including overloaded signatures and the Max helper. PR3694 merge0ea87e3c564f6fd62ee5e3de00167e0e11fc8bbd is an ancestor; its historical footer defect and all prior RED receipts are retained. Old frozen stacked branches and evidence are unchanged.

Actual source-stage selected1 C# file with zero violations; qualificationEligible=false. Complete token/AST/XML-stripped bytes, signatures, meaningful17/17 docs, XML diagnostics and mutation/malformedXML refusals pass at the new candidate. Current scoped intent, authoritative docs, lifecycle and trusted current-base commit-range checks pass. Toolchain SDK10.0.401/Node24.16.0. UI/mobile/dark/accessibility, AEDS/public API/database migration, generated outputs, performance and blame-ignore items are inapplicable; checked boxes record impact review, not runtime acceptance. No TODO/FIXME added.

Independent security/architecture review, broader full/domain/native/cross-node qualification, and later separately authorized merge/current-master acceptance remain OPEN. SQLite NU1903 and unrelated existing global code-intent refusal at font_theme_admin_pods.hpp remain explicit. The original local docs-type title was rejected by the unchanged path-based checker because src/ is classified as runtime; the final prospective title uses chore(security), as the earlier XML-only source continuation did. The rejected diagnostic remains recorded; no policy or candidate history changes. This local prospective metadata check is not GitHub PR admission. No API content mutation, policy change, test relaxation, held ProjectXML audit, merge or deploy. Roll back inaccurate owned XML through normal review.
