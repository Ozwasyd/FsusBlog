## Linked Issue

Refs #3647

## Scope Summary

Correct one XML statement for a missing ban authority fact: it supplies no fact and the existing local reread may see a concurrent applied fact. Original17 declaration docs already in the exact prerequisite base are retained. The two-path diff changes no tests, oracles or runtime tokens.

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
- [x] Targeted backend tests: actual fresh run at candidate7288b3b0e0211b2c0fa0531ab01e657e4f5e57c2: unchanged original BanStateProjection/Convergence15/15, zero failed/skipped. Original whole test-project build and locked restore pass; no old263 outcome inherited.
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
- Rollback: revert inaccurate owned XML wording through normal review; canonical prerequisites remain under their existing owners.
- Deferred work: independent security/domain review, original full qualification, later separately authorized merge and current-master recheck.
- Known limitations: source stage explicitly has qualificationEligible=false; historical merge-footer and global RED receipts remain. PostgreSQL/Redis cross-node convergence and full/native/runtime qualification are not established by263 tests.

## Notes For Reviewers

Related to #3647. This standalone scope is reviewed only between exact base4fde8307d43ca8ee1b38cf71fbde3786f6ae46f5 and head7288b3b0e0211b2c0fa0531ab01e657e4f5e57c2. No frozen head or published history changed. The prerequisite includes genuine test/oracle changes and remains separately owned by canonical #3654, retaining exact #3568 lock and #3665 existing verifier. Official #3654 justification: https://github.com/Ozwasyd/FsusBlog/issues/3654#issuecomment-6053286651 . Production observer/bootstrap/schema runner/helper blobs remain unchanged; raw original244/248 and CS0619 refusals are preserved separately. Tests/oracles are not claimed unchanged in the prerequisite scope.

The docs scope must remain stacked on unaccepted prerequisite4fde8307d43ca8ee1b38cf71fbde3786f6ae46f5; it cannot retarget to master and hide the aggregated prerequisite diff. Its original projection test files are unchanged, and exact17 coverage is traced by historical node/token identity, not only member names. Current source-style selected7 C# files for prerequisite and1 for docs; both actual raw gates pass. Each actual original test project builds normally without altered Project XML or assertion skip. UI/screenshots/mobile/dark/accessibility, AEDS/public API/database migration, generated outputs, performance and blame-ignore items are inapplicable; checked review boxes record impact review. No TODO/FIXME added.

Independent review and full/native/domain/PGRedis convergence qualification remain OPEN; source matrix qualificationEligible=false. Local scoped evidence does not erase historical merge-footer/global RED. No PR/API content mutation, merge or deploy. Rollback inaccurate owned documentation through normal review; prerequisite API/oracle adaptations require their canonical owner review separately.
