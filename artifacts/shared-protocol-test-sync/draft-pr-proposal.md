## Linked Issue

Refs #3735

Related to [#2325](https://github.com/Ozwasyd/FsusBlog/issues/2325), [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736) and [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738). All remain open.

## Scope Summary

- The original protocol test still expected 260 frames after consumer `7b374e71f89433cf04e5e315fdd1d43816728f85` registered 263. The compatible one-file source commit `60c03fa44b7fa090bc1a6b227596943e19c3c3b8` synchronizes those assertions, explicitly covers 269–271, reconstructs the historical evidence projection and appends FutureFrame at the next sequence position. Prior canonical correction is `71179da783bae459b665b1ca168a97b718b4b01b`; no later 273-frame registrations are imported.
- This is a consumer-specific branch based on supplied 7b374, not latest inspected master `a281fb6e9802471c3a44569c3ccab84f88c8d816`. A master-targeting PR from this branch includes 144 inherited changed paths plus nine new ordinary evidence/proposal files, **153 paths total**. The full inherited list is in `artifacts/shared-protocol-test-sync/run-evidence.json`; this increment does not newly qualify that closure. Prefer consuming the exact one-file commit into the original consumer PR.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [ ] External naming exception
- Contract impact: none for this increment; inherited consumer scope remains unaccepted.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests: unrun; no backend source changed by this increment.
- [ ] Targeted frontend checks: full types/build unrun.
- [x] Other: original Node24.16.0 `node:test` runner and original protocol producer, 36 passed / 0 failed / 0 skipped, exit 0, at exact source `60c03fa44b7fa090bc1a6b227596943e19c3c3b8`. Original producer `--check`, five outputs in sync, exit 0. Exact positive selection/count, every test call site, both data loops and absence of hooks verified before running. Held test bodies 0. Raw commands, names and results are public in `artifacts/shared-protocol-test-sync/`.

The first static selector preflight failed before any test body and is retained. Source and full increment whitespace checks pass; no full branch CI or inherited acceptance claim is made. Later evidence-only commits do not extend the tested source binding.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

No new UI source change or rendered acceptance is claimed by this test-only increment.

## Coding Convention

- [x] C# mother-style mapping checked
- [ ] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable
- Formatter identity: none; test-only assertion repair, not a formatting migration
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

Normative public API semantics are unchanged by this increment; no API documentation update is needed. The ordinary historical handoff records exact scope, producer ownership and acceptance limits. No TODO/FIXME was introduced.

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

Bounded source reviews above apply only to the new test increment. No new wire/ABI/database/auth/proof semantics change. Existing registered IDs and five fixed historical hashes are preserved, all 21 original negative controls are byte-exact, and the canonical manifest/producer/five products are unchanged from supplied 7b374. Inherited consumer source retains its own separate review requirements.

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no performance claim

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: synchronize protocol assertions with registered roots

## Generated Output

- Generator source: none changed by this increment; unchanged original producer verified with `--check`
- Generated outputs: none changed by this increment
- Digest/evidence: none for generated-source mutation; ordinary execution provenance is `artifacts/shared-protocol-test-sync/run-evidence.json`
- Automation identity: none

## Rollout / Rollback

- Rollout: source handoff only. The coordinating parent is the sole GitHub content writer and decides the existing-consumer PR handoff or separate draft publication; no merge, deployment or issue closure.
- Rollback: revert only the one-file source increment before integration; preserve subsequent consumer registrations.
- Deferred work: consume exact commit into original2325 and rerun against its resulting SHA; inherited closure and complete types/build/CI/runtime/product acceptance.
- Known limitations: 36-case result is bound to 60c03fa44; no 419/45 consumer rerun, HTTP/Postgres/UX, held audit or qualification was performed here.

## Notes For Reviewers

Proposed draft title: `test(shared): synchronize protocol assertions with registered roots`. Proposed head: `codex/shared-protocol-test-sync-20261009`; target: master. This document is a prepared proposal, not proof that a new PR exists. Actual inherited scope must remain visible if this branch is used for a master-targeting draft. The parent may instead consume only the exact compatible source commit into the original consumer PR.

C# mapping, blame-ignore, external naming, performance, new generated-source, public API document and UI review items are not applicable to the one-file test repair. Checks on those entries record bounded applicability review, not complete inherited scope approval. Raw logs and execution summaries are ordinary evidence, not generated product qualification. No existing producer/fixture/hash/gate was weakened. Held audits remain stopped.
