# Independent workspace race audit — blocked candidate handoff

This is a quarantined adversarial harness for issues #2302–#2306. It is not an
acceptance receipt or an implementation of those issues. Production source and
owner tests are unchanged. Integration requires the implementation owner's
approval. No server, cache, editor factory, SDK proof or two-group manager is
invented by these tests.

Published source inspected: `0e9dd5751bdd584204fd149bdb1526b97ff682a6`.
Initial configured checkout: `0a755584aa256995fd9997ca974806e8a0e29d2e`.
The three authoring source files below have identical bytes in those candidates.
FsusUI checkout inspected: `f2b3bb89ffe5f749da26c388f058efdbb6aee864`.
Node: `v24.19.0`; actual installed runner: Vitest `v4.1.5`.
The configured .NET SDK is available after sourcing `/workspace/.setup/activate.sh`
(`10.0.401`), but this published candidate has no workspace snapshot API/store.

All five live issue bodies and their initially empty comments were read through
GitHub on 2026-10-08. No matching workspace branch/open PR was discovered. Exact
candidate requested through the coordinator and in issue #2304. This audit is
bounded to the actual published interfaces while that candidate is unavailable.

## Reproduce

From the audit checkout, with the original frontend dependencies installed:

```bash
src/frontend/node_modules/.bin/vitest run --config src/frontend/audit-workspace-races-20261008/vitest.config.ts
```

One run only: **5 passed, 3 failed**. `first-run.log` retains the original raw
output and failures. No unchanged full suites were run. The first shell wrapper
redirected Vitest output and then printed the file, so its final shell status was
0 from `cat`; this is not a passing test result. The runner's explicit failure
summary and assertions are the outcome. The reproduction command above invokes
the runner directly and propagates its failure status.

The five passing probes establish only:

- Local Registry rejects a second writer's stale revision without mutation;
  this is **not** a two-browser/server PostgreSQL CAS proof.
- A second same-article open in another group coalesces into one existing session.
- A second article cannot reuse an existing editor session ref.
- Mutating a cloned exported Registry state does not mutate Registry authority;
  this is **not** a verified-cache authority test.
- Mutating permission before the actual router readiness await resumes blocks
  that readiness result with `session-result-stale`.

## MUST_FIX dependency: revoked article reactivated by open-or-activate

Actual source: `openArticleDocumentRegistry.ts`, existing-identity branch around
lines 672–685; the checked `applyActivate` branch starts around line 752.
Failing test: `open-or-activate must not reactivate a permission-revoked existing tab`.

Interleaving:

1. Open article 1 at Registry revision 0.
2. Open article 2 at revision 1, leaving article 1 inactive.
3. Execute `invalidate-permission` for article 1 at revision 2.
4. Execute `open-or-activate`, `entrypoint=recent-restore`, for article 1 at the
   now-current revision 3.

Expected: `rejected-state`, no revision/state change, article 2 remains active.
Actual: `activated-existing`, revision 3→4, revoked article 1 becomes active,
article 2 becomes inactive. Permission remains `revoked`; actual returned
`authorityRef` comes from the command's old `allowed` statusRef.

Actual command digest:
`6419c0966baa9c759dc87a5cf392e6d8238bc87d824f39f3af32eb36188b5a8e`.
Actual result digest:
`8cee656727f5bf7796dbb08baeb75e2ff968e60e96e385cb41a3e813646d1ff3`.

This finding is in a published dependency, not an unpublished #2304 candidate.
Minimal producer boundary: immediately revalidate current permission/lifecycle
and binding before applying each restore action. Existing entries must use the
official checked `activate` command with current expected revision. Cancel the
plan if that binding changes. Refer any Registry core fix to its owner; this
audit does not edit excluded session/router core. This proves incorrect Registry
activation; it does **not** prove protected article content is disclosed by an
actual editor or API.

## Two additional failed consumer invariants

The harness deliberately demands the safety required of the future restore
producer. These are **dependency limitations**, not claims that existing router
methods promise full restore cancellation or that absent #2304 source is broken.

`reset()` during a pending open: the synchronous Registry mutation has already
occurred; reset clears presentation/readiness maps but leaves Registry entries
and resets counters to 0. The actual immediate readiness await then returns
`ready` and repopulates readiness (`receiptRef=tab-router:0:0`). Expected at a
cancel/dispose boundary: reject the late result. Producer suggestion: maintain
a monotonic scoped restore generation/disposed token; check it before and after
every await and before applying any action. `reset()` is not that cancel API.
No actual host dispose API was available in this snapshot owner.

Out-of-order navigation: A's real router call reaches its navigation await; B
completes a newer navigation; A completes last. A returns `applied` with
`generation=1`, `registryRevision=2`, route to article 1 while the active Registry
tab is article 2 and B completed at generation 2. Expected at the restore
publication boundary: older result is stale and cannot replace current UI truth.
Producer suggestion: reject an older plan/result generation before publishing
summary/cache/UI, and do not treat an old `applied` router receipt as current.
The deferred navigation port produces no session or server receipt. Editor
readiness is solely the existing router's own default memory implementation.

## Blocked distinct probes and their next deterministic interleavings

| High-risk invariant | Exact unavailable owner/interface | Next bounded probe once provided |
| --- | --- | --- |
| Two tabs stale server CAS | #2302 authoritative read/write API and storage, #2303 flush coordinator | Both read revision r; pause B before write; A commits r→r+1; release B; assert conflict, reread, no retry-overwrite/cache promotion. |
| Verified cache never authority | #2303 cache parser/atomic storage/online startup | Seed an actual last-verified server response; block server read; assert only tagged placeholder/default and zero restore/flush authority actions. |
| Offline unsynced and reconnect | #2303 network/dirty/flush state machine | Disconnect after r; make bounded layout changes; advance remote server revision; reconnect; release current server read; assert unsynced/choice, no replay/merge/overwrite. |
| Revocation after restore planning | #2304 batch resolver, immutable plan and apply boundaries | Resolve allowed; pause before first session command; revoke authoritative permission; release; assert binding change cancels/skips, no active/ready unauthorized session. |
| Interrupted two-group collapse | Official #2298/#2299 group/layout manager and transaction boundary | Pause collapse after first ownership transition; cancel/change viewport or revision; release; assert every article remains exactly one owner and no third group/mirror. Do not model this with standalone per-tab ownership commands. |
| Out-of-order snapshot responses | #2303/#2304 authoritative read/restore epoch | Start A read/plan; start newer B; release B then A; assert server/user/site/source/build/revision/generation binding rejects A. |
| Cancel/dispose during restore | #2304 restore scope cancellation and host integration | Pause each asynchronous boundary; cancel/dispose or switch user/site; release; assert zero late session/group/shell/cache mutations and no pending timer/channel resurrection. |
| Real SDK/runtime end to end | Actual FsusUI session factory wiring, initialized authoritative server DB/runtime | Use original implementation; do not synthesize session proofs or schema admission receipts. |

No claim is made about cache identity/freshness, offline queue absence, server
CAS/reset, DB uniqueness, interrupted group transaction atomicity, real editor
permissions/disposal, migration UX, browser restart or terminal #2306 acceptance.
Published source has no matching workspace implementation. FsusUI contains no
matching `captureSnapshot`/`restoreSnapshot`/`disposeAfterSnapshot` factory
implementation in the inspected markdown-editor source; similarly named language
tool sessions are a different API. Setup notes also record an uninitialized
backend schema admission block; that historical setup note was not retested or
reinterpreted as current backend execution evidence here.

## Source and raw evidence binding

SHA-256 of exact Git blobs at the inspected published source:

| Path | SHA-256 |
| --- | --- |
| `src/frontend/src/services/authoring/openArticleDocumentRegistry.ts` | `12c2f5b78d43aa2b654ae9d6f20a0b6e6acf396b4baa10e94a0a632b255a8033` |
| `src/frontend/src/services/authoring/articleWorkspaceTabRouter.ts` | `817afff321e49c6d4e50dba48aa9e17b9ec26749f552bc3cb951114d2467a7bd` |
| `src/frontend/src/services/authoring/authoringSessionHost.ts` | `a3fff081d325074b340bed5417e31e17bec3aa349a42387d9c650c1750b845fa` |
| `first-run.log` | `79448d76aab186ece1253ef1bf471398a7ad31bd2b4f7d3250451f3d4d1ecd92` |

Immediate factual WIP and MUST_FIX reports:

- <https://github.com/Ozwasyd/FsusBlog/issues/2304#issuecomment-6053328067>
- <https://github.com/Ozwasyd/FsusBlog/issues/2304#issuecomment-6053355723>

No acceptance approval, package publishing, deployment, merge, production writes,
gate weakening, fabricated legacy histories or fake fixtures/receipts occurred.
