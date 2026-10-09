## Linked Issue

Refs #2246

Related to [#2256](https://github.com/Ozwasyd/FsusBlog/issues/2256), [#1975](https://github.com/Ozwasyd/FsusBlog/issues/1975) and [#2283](https://github.com/Ozwasyd/FsusBlog/issues/2283). WIP source prerequisite; no issue acceptance or closure.

## Scope Summary

- Lend the existing `readOwnedIntent` through the real Writer `authoringAttachmentRuntime`. The callback binds the original private adapter to the existing current context/source public-map port, allowing the business owner to retain original handles without access to a second adapter, source store or caller-supplied map.
- Base `37143050f01346bde533686e383ba93f0dd053d8`; branch `codex/chain-2246-writer-owned-intent-read`; tested and remote-verified head `d953e820094c32a2f11d5cd5cfaf269a369e4b06`. Incremental change: two host lines and27 new ordinary-control lines. Frozen prior branches and original producer files remain unchanged.
- Read the supplied `3a4729cc2c8bf6a01830049d7bbcb734ee16ce06` and its exact direct parent61d686739fca17aa3f3fad3840de315c4d35eabe. Its current responsibility/draft readers exist, but the supplied tree has no production current-reader call site or Shared transport export; its API contract explicitly leaves transport/DI unchanged. No backend source was imported into this frontend-only handoff.

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
- [ ] Targeted backend tests: N/A; no backend change. Upstream8 admission/89 ordinary controls are producer evidence, not this host qualification.
- [x] Targeted frontend checks: exact38 passed,zero failed/skipped/todo (original current-authorities16,authoring-gates15 and host6 unchanged,plus one actual-host consumer control). Original hooks and full nonempty runtime names/count guarded before the same positive pattern. Run began `2026-10-09T09:40:56.256Z`, actual Node24.16.0/Vitest4.1.5/UI0e5c56050e8dd3e9ca3735078489d35a0bb6e3d2.
- [x] Other: commit-contract range37143050f01346bde533686e383ba93f0dd053d8..HEAD and diff check exit0. Full application types232→232,added0/removed0,both exit2. Scoped host lint exit1 with only three original stale baseline digest errors. Read-only supplied-tree contract probe exit0; it is source-only absence evidence, not runtime acceptance. Source push/readback exit0,one attempt,no retries.

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
- Summary: lend owned attachment intent reads through Writer

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: source draft review only; no merge,deploy,auto-merge or issue closure. GitHub content APIs remain paused and are reserved to the monitor.
- Rollback: revert the one incremental host-binding commit without altering the frozen original reader or host predecessors.
- Deferred work: release original authorized runtime consumers/DI plus Shared/AEDS input/result observations for the current server services; preserve server-only bytes, genuine current editing responsibility fields and durable post-transaction cleanup evidence. The supplied source does not name the coordinated root for transport; the parent must route it to the existing sole owner.
- Known limitations: local current intent observations grant no server/asset/reference/cleanup permission; terminal or unknown observations remain unqualified. Current responsibility transport remains `unavailable`. Global types, original style baseline, frozen focus4/5 and SOURCE remain open.

## Notes For Reviewers

The new control commits and removes a pending item through the real public editor and original Writer port, reads the exact original handle/snapshot/current context, rejects a cloned handle, observes actual removal, and checks withdrawal on unmount. It issues no preview/history request and creates no qualified asset projection. Original37 controls and hooks were unchanged. The ordinary SDK/mock API environment does not qualify production HTTP, native runtime, UI/UX, database or server bytes.

The supplied backend signatures are `ReadAuthorizedAsync(RevisionCompareReadContext,int,long,CancellationToken)` and `ReadSavedDraftInputAsync(CurrentDraftUploadAssetReference,ClaimsPrincipal,UploadSessionAccess,string,Func<CurrentDraftUploadAssetContext>,CancellationToken)`. The sole source boundaries for their runtime export are original AuthoringEndpoints/WorkflowRoutes, RuntimeDomainServiceCollectionExtensions and Shared/AEDS owners, with repository CODEOWNER @Ozwasyd. No route name,frame number,DI registration,upload credential or browser ClaimsPrincipal is invented here. Existing `getServerDraft` returns no current responsibility/asset-authority observation; responsibility GET returns a revision history array. Those existing APIs cannot substitute for the new service acceptance.

N/A review reasons: no C#,external HTTP/wire/ABI/AEDS/database/security/auth/PoW/privacy semantics,generated output,shared token,naming exception or mechanical-only revision changed. This internal callback borrows the existing reader and its documented limits; it creates no new cross-stack contract or document authority. No TODO/FIXME was added. Accessibility/reduced-motion presentation is unchanged; screenshots/mobile/dark/native acceptance were not performed. Original lint was run but qualification failed on unchanged baseline digests, so its checkbox stays unchecked.

No GitHub content API write or PR creation occurred. The complete body is supplied as payload for the monitor. Whole chain remains open: #2246/#2250/#2253/#2256 partial; tracking#1809 awaiting all child/boundary evidence; #2280/#2282/#2284/#2286/#2287 retain canonical source owners and pending host/terminal acceptance. Same-work#3619/#3721 remain with their own roots.
