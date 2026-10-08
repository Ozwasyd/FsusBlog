## Linked Issue

Refs #3464

## Scope Summary

- Add one sealed, charged native metadata index with unmanaged artifact descriptors, bounded UTF-8 key storage, fixed-width ID and route tables, and full-key comparison after real full-hash collisions. Canonical routes still come from `PublicHotReadRouteKeys.HtmlPath`.
- Add bounded copy-on-write replacement/deletion and a simple counted-reader protocol. A local generation holder serializes selection/acquisition with publication; retired blocks remain charged until every actual reader ends, including async work after cancellation of an outer wait.
- Add 14 tests in the actual owning backend test fixture, including differential lookup/update, malformed layouts, changing collection counts, concurrent publication, and final-budget competition. Supporting evidence is in `artifacts/memory/mem-3464/report.json`, raw logs/TRX, `source.diff`, and preserved reproduction inputs.
- This is a source increment. Base: `b9c076e4b763130075218ff9d50f9a6c36784f59`. Tested source: `bc3dadbb325dcbcff5c22fb2e7e270d2a1514136`. The six consumed common-contract/accounting files are exact blobs from `089d95e466c23a7fc781d30b80157cb4dd199c10`, PR #3845; they were injected externally for compilation and are deliberately absent from this branch's diff/history. Integrate compatible common source first. No broad WIP branch merge, shared registry change, production activation, or qualification receipt is included.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [x] External naming exception
- Contract impact: none

## Tests Run

- [ ] `./tools/test.sh fast`
- [x] Targeted backend tests: `dotnet build src/backend/FsusBlog.Server.csproj --no-restore -p:PublishClientAssets=false -p:CustomAfterMicrosoftCommonTargets=/tmp/mem-3464-contracts/contracts.targets` passes with exact external prerequisites; `dotnet test /tmp/mem-3464-tests/IsolatedTests.csproj --no-restore` executes the actual linked owning fixture against the actual backend assembly: 14 passed, 0 failed, 0 skipped.
- [ ] Targeted frontend checks:
- [x] Other: C# changed-file style, C# entrypoint ownership, and change-contract range checks pass. All commands and actual exit codes are recorded in `report.json`.

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

- Exceptions manifest: artifacts/memory/mem-3464/external-naming.json

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
- Non-goals: No CPU/latency/peak-memory benefit or product acceptance claim. Informational lease-count measurements and inline field sizes exclude full production serving fields, referenced payloads, FrozenDictionary storage, managed headers and runtime overhead. The reference counted protocol is retained; no optimized reclamation substitution is introduced.

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: add sealed native artifact indexes with counted leases

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: Source-only draft; original #3444 owner integrates compatible common APIs, registers exact ownership paths, and wires authoritative snapshot/payload lifetime plus qualified Auto/reference selection before any activation.
- Rollback: Stop future flat generation construction through the existing owner and retire the local holder. Keep all live index/payload leases until actual completion. Payload identity, protocol, publication/revocation authority and hard admission stay intact.
- Deferred work: Production Auto/Disabled selection, actual payload backing/serving integration, complete byte/header/status/revocation oracle, frozen CPU/latency/peak-memory gates, independent review, platform execution and issue closure.
- Known limitations: ARM64 and other platforms remain NotVerified. Docker tests and OS-protected write rejection were not run. The complete owning test project is blocked by baseline NU1004; isolated fixture execution is not a claim that that full project passed.

## Notes For Reviewers

This PR must remain a draft. Shared source, source/history/matrix registries, common policy and serving activation are owned by original #3444. Native descriptor handles do not own payload backing or grant content eligibility; the integration adapter must retain and validate actual backing roles/leases and existing publication/revocation checks.

`check-code-intent.mjs` currently fails with two introduced registration dependencies: the ownership markers in `Host/FlatArtifactIndex.cs` and `Lifetime/FlatArtifactIndexPublication.cs` require exact source-path registration by the shared registry owner. Its separate `font_theme_admin_pods.hpp:338` no-allocation claim failure reproduces on clean master. No registry or marker was weakened to produce a pass.

`ci-pr-smart --stage source-integration --base-ref <exact-base>` is rejected before execution by independent release-final Node parser identity drift and execution authority schema/source-index/parser identity. The same rejection reproduces on clean master. No held ProjectXML, semantic-adapter or cohort-pointer QA scope was substituted or bypassed. The clean-master locked restore also reproduces NU1004; lockfiles remain unchanged. Missing or blocked checks are not passes. GitHub CI is disabled.

UI evidence checkboxes are reviewed as not applicable because this changes no UI. There is no public/wire/ABI/database contract change, TODO, generated canonical output or mechanical migration. The changed narrow external-naming manifest covers the four new backend source paths under the existing path-based environment-variable surface without introducing any environment key or changing that registry; XML ownership comments and the proposed task handoff cover this internal source increment. Raw command output is supporting evidence, not a maintained generated product or acceptance receipt. No issue is closed by this PR.

GitHub secondary HTTP403 content-creation limits prevented the reservation comment, and the central coordinator explicitly paused new comments/PR creation. This body is preserved locally for one coordinated draft creation after release of that hold; source pushes succeeded without changing accounts, endpoints or transports.

Refs: #3464
