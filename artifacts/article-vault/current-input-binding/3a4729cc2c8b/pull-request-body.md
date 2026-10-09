## Linked Issue

Refs #1975

Related to [#2258](https://github.com/Ozwasyd/FsusBlog/issues/2258), [#2263](https://github.com/Ozwasyd/FsusBlog/issues/2263) and [#2283](https://github.com/Ozwasyd/FsusBlog/issues/2283). No issue is accepted or closed by this source-preservation draft.

## Scope Summary

Compose the supplied current responsibility and saved-draft readers with the original current-article upload supplier. Saved drafts can return original owned input bytes only while the original owner/context/server revision/source and exact canonical reference remain confirmed. Article and draft consumers share one exact source-edge binding; native/upload validation remains the original FileService implementation.

Expose the original internal ledger scheduling entry to the released cleanup consumer. It requires the caller's open transaction, reacquires the original asset advisory lock with seed1779, checks every candidate owner before scheduling, and forwards to the original private queue scheduler. Original24h grace, reference protection and restoration cancellation remain intact. A successful Task is not a durable cleanup receipt.

Incremental runtime source: `3a4729cc2c8bf6a01830049d7bbcb734ee16ce06`, based on original supplier `61d686739fca17aa3f3fad3840de315c4d35eabe`. Supplied reader identities: responsibility `76473e9dd3feb7e06e73fe085053373d6dbf45ae`; draft `53bba36b436502c3dd3e4b4d48b229a1c348d28b`. Only their reader/test files were composed. The subsequent delivery commit adds documentation and retained observations only.

The branch retains earlier source and supplied dependency ancestors, including the registered frame275 producer and asset-input supplier. Its merge-base with observed master `4937961e02ff587c2e13b8a463c9709ddfd82359` is planning master `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`. The full master diff requires the later coordinated ownership/conflict review; this is not an isolated eleven-file PR or a merge-ready candidate.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [ ] External naming exception
- Contract impact: compatible

The earlier registered public frame275 lineage is retained; this increment adds server-only reader/scheduling methods and changes no wire/ABI identity. Retained raw run artifacts are source-bound observations, not registered generated source or a replacement gate.

## Tests Run

- [ ] `./tools/test.sh fast` — not run for this increment; held/broad suites remain excluded.
- [x] Targeted backend tests: exact source3a4729 standard-project build/discovery exit0; nonempty positive admission8/8 followed by four-class regression89/89,0skip,exit0. Exact commands/run IDs/counters are in `artifacts/article-vault/current-input-binding/3a4729cc2c8b/handoff.json`.
- [ ] Targeted frontend checks: not run; this increment changes no frontend runtime.
- [x] Other: nine changed C# files canonical style0 violations; `node tools/governance/check-change-contract.mjs --range 61d686739fca17aa3f3fad3840de315c4d35eabe..3a4729cc2c8bf6a01830049d7bbcb734ee16ce06` and matching `git diff --check` passed.

Draft59 + responsibility22 + shared binding3 + cleanup5 =89. Each of the two PostgreSQL runs has actual task-container create/start/kill/die/destroy events and an empty final owned-container observation. SDK10.0.401 and Node24.19.0 were observed. Build has1530 warning lines; no zero-warning/full-CI/product/native qualification is claimed. Supplied22/51 results were not inherited. Earlier61d native56-case evidence remains bound61d.

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

- Exceptions manifest: none

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

Readers return current facts, not root grants, verified intent or reuse/reference/cleanup receipts. Actual original server draft key, saved server:N ACK, opaque Writer DraftId, editor revision, article revision, context/canonical JSON digest and raw source SHA remain distinct. A closure over an incoming static request DTO is not live browser context authority. No secret draft save, production database operation, deletion or deployment was performed.

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no performance, zero-warning or terminal migration qualification

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: integrate current draft asset and responsibility inputs

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: source-preservation draft only; sole owner3735 composes the supplied scoped DI hunk and original authorized AEDS transport after coordinating identities. The unique cleanup worker owns original session/transaction scheduling composition.
- Rollback: withdraw these source increments before runtime activation; no production schema/data change requires reversal. Keep original unconfirmed/recovery-required refusals and scheduling facts; do not fabricate receipt state.
- Deferred work: exact cleanup observer identity and cancellation acceptance; original intent/reference/cleanup authorities; complete current host/transport/product acceptance; original native/profile terminal migration composition and isolated apply/repeat/restore.
- Known limitations: #1975 remains partial and #1976 waiting; all16 issue gates are retained in the bundle. No Windows/full security/performance/held receipt audit or independent product qualification. Existing shared-document inventory baseline failures remain unresolved and are not counted as passed.

## Notes For Reviewers

Draft title: `feat(backend): integrate current draft asset and responsibility inputs`. Proposed release label: `release-note:internal`; only the authorized monitor may apply it. Target master. Source branch: `codex/chain-1975-current-draft-integration`.

Not-applicable checklist items were reviewed: no independent mechanical-format/naming migration, blame-ignore revision, naming-exception manifest or registered generated source was introduced; no new docs path requires lifecycle registration; no TODO/FIXME was added. Current docs were updated through their existing maintained paths. Existing document inventory failures are disclosed rather than waived.

The cleanup scheduling member belongs to an internal backend type and directly calls the original private scheduler. Do not copy its SQL, create another queue, delete native assets here, or treat SchedulingRequired/Task success as recorded cleanup. A singleton FileService caller resolves the scoped DB via its original scope factory and avoids observer reentry while holding its original session lock.

The DI patch is delivered, not applied to another owner's file. The cleanup observer identified only by327f has not been guessed or consumed; its full identity and cancellation-fix acceptance are required for dependent wiring. GitHub content writes remain paused, so this is the complete body supplied for the authorized monitor, not a created PR. Older draft3813 excludes these newer increments. No master push, merge, auto-merge, issue close, deployment or package publication is authorized here.
