## Linked Issue

Refs #3460

Related peer work: [issue3462](https://github.com/Ozwasyd/FsusBlog/issues/3462). Common contract owner: [issue3444](https://github.com/Ozwasyd/FsusBlog/issues/3444), [PR3845](https://github.com/Ozwasyd/FsusBlog/pull/3845).

## Scope Summary

Add real C# CUDA/HIP allocation, async DMA and peer APIs plus Metal private/shared buffers and async blit ownership. Integrate bounded, ledger-admitted staging, immutable initialization, exclusive peer destinations, cancellation-independent completion, epoch invalidation, uncertain-resource quarantine and safe drain. Keep BAR reporting separate from supported CPU mapping and consume common qualification facts for per-workload selection.

Seven prerequisite files are exact unchanged blobs from 089d95e466c23a7fc781d30b80157cb4dd199c10, imported narrowly onto actual master b9c076e4b763130075218ff9d50f9a6c36784f59. The broad WIP branch is not merged. Tested source is f4836b86c3132a1b1f41518ff753d80cdc35bd15; evidence-only commits do not alter those source bytes.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: compatible

## Tests Run

- [ ] `./tools/test.sh fast`
- [x] Targeted backend tests: 102 ordinary exact-source isolated GPU unit cases passed; full owning project restore is blocked by offline dependencies. Raw logs/TRX retained under artifacts/memory/mem-3460-3462.
- [ ] Targeted frontend checks:
- [x] Other: exact-candidate backend build; unchanged prerequisite blob comparison; diff check; commit-range Change Contract; whitespace formatter. C# static admission FAIL is retained. Applicable PR planner is blocked by execution-authority Node parser drift. Native/platform/performance and Docker checks are NotRun/NotVerified.

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
- Formatter identity: dotnet format whitespace, repository .editorconfig
- Formatter version: SDK10.0.401
- Formatter command: dotnet format whitespace src/backend/FsusBlog.Server.csproj --no-restore --include exact task-owned C# paths
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: artifacts/change-contract/mem-3460-3462-external-naming.json

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] Cross-language coding conventions reviewed
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
- Non-goals: native hardware qualification, automatic serving activation, performance improvement claims, raw BAR access, replacement network stack, independent publication/accounting/capability authority

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: add retained GPU backends and peer source contracts

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: source preservation only; no serving/startup configuration changes or production activation.
- Rollback: stop new selection, retain and drain submitted owners, then release confirmed resources. Uncertain DMA/context custody stays charged and requires the common controlled-restart disposition. No whole-card readback.
- Deferred work: frozen matrix/physical allocation bounds, common Auto qualification/recovery integration, residency eligibility/publication/coalesced fallback, actual native mapping/peer consumer rows, real platform evidence, independent review and full required admission.
- Known limitations: missing GPU/macOS hardware; incomplete offline backend-test dependencies; static delegate-parser diagnostics; execution-authority Node parser drift; GitHub content-creation limits prohibit draft PR submission at present.

## Notes For Reviewers

This is a locally prepared draft body, NOT a created PR. The central coordinator must publish it after releasing the repository content-creation limit; suggested title is `feat(backend): add retained GPU backends and peer source contracts`, with `release-note:internal` if that is the registered matching label.

No issue acceptance or closure is requested. Unit simulations do not establish native qualification. Public contracts here are internal backend extension seams; XML ownership docs are in source. UI/AEDS/wire/auth/database/deployment flows are unaffected, so their review boxes record not-applicable review. There is no mechanical repository-wide migration or blame-ignore revision. Historical evidence is source-bound and does not replace current architecture ownership or held QA gates.
