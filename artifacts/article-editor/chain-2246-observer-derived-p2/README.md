# Derived observer assimilation P2: source-only correction

## Source and review boundary

- Independent reviewer confirmed original thrown-Promise terminal false-success closed at `3916a5ea219238d0ebb57a2e4a58dd61980fc867` and reported this distinct derived-observer P2.
- Supplied/current base `7cd9e3806ffe7de7156950de31e2021ff34afe5b`; final implemented/tested source `3c5e3f19b0f9cf1a6aafc6b308a76f43f9a03b0e`.
- Minimal code/control net: original `articleFsusUiRenderProducer.ts` and its existing test file only. No other owner implementation is changed.
- Branch `codex/chain-2246-preack-runtime-intake`, draft https://github.com/Ozwasyd/FsusBlog/pull/4153.
- Fresh fetched origin/master `47c8d3b5850d551ae3f2f4f4ad77aa98d1fc5d1a`; current delta from previously checked 280415 concerns comment/user tables and tableV2 boundary files, outside this producer/caller fix. Not incorporated. Current #2246 body re-read; issue criteria/prohibitions preserved.

Old observer `Promise.prototype.then.call(cause, undefined, onRejected)` forwarded its original fulfilled value into the derived Promise. A value's `then` getter could return undefined at initial resolution and throw a future at derived assimilation. The derived asynchronous rejection escaped the synchronous observer catch; its actual cause was not held and its rejection could be unhandled. Previous source-only static green does not prove that boundary safe.

## Actual fix

The original rejection observer supplies explicit fulfillment and rejection handlers returning `undefined`. It discards the fulfilled value for observation only, instead of implicitly forwarding/re-assimilating it. This changes neither the original source/result Promise nor render/admission authority.

The actual intrinsic `then` result is kept in the same original request's private `observerPromises` custody. A real async completion awaits that derived Promise and catches its asynchronous rejection. That completion is also retained. On actual rejection, the original endpoint error, actual derived Promise and actual observation failure are held together in `cleanupFailure`'s Error cause chain. Synchronous instanceof/species/observer failure handling remains intact. No source value is copied and no second body cache, resource ledger, owner, registry or parser is introduced.

Observers are not terminal proof: pending unknown endpoint remains rejected/unconfirmed, including after its source/observer future later ends. The same-request `getRequestWork(request)?.terminal` API is unchanged. Old internally minted cancellation provenance and actual result/cleanup/native guards remain unchanged. A later async observer error updates the original work's actual cleanup custody; it does not turn an already rejected terminal into success.

Current cache does not consume this producer terminal, and its null/unknown correction/terminal consumer remains #2245's sole-owner WIP. No demonstrated cache lease-loss, native/global cleanup, successful eviction or full-session factory qualification is claimed.

## Two additional source controls, UNRUN

1. Original public producer/source callback throws an actual pending native Promise. Its fulfilled object has a getter returning undefined only on first `then` read, then throws an actual pending future. Explicit fulfillment discard avoids a second read; original unknown terminal/lease remains held.
2. A real species capability returns an actual native derived Promise and deliberately replays that object during resolution, forcing asynchronous rejection even with the no-op fulfillment handler. The control checks actual derived Promise identity, failure future identity and retained original endpoint/cause. It also checks terminal/cache unknown refusal, without qualifying any native cleanup.

These use the original constructor/document/cache and real Promises, not fake terminal owners or a replacement renderer. Existing ordinary Error/throw/returned-future/then-getter/observer/disposal/native/release/same-request controls remain unchanged. They were only AST parsed, not executed or collected. No unhandled-rejection count or runtime pass is inferred.

## Current static gates

Run identity `/workspace/.tmp/chain2246-observer-derived-p2`; machine-readable commands, exits, ownership hashes and raw logs adjacent. Official Node v24.16.0, locked TypeScript/Vue/style tooling, actual local FsusUI `6a73ad6312091ca782f99393140efc8df0fb4fb6`, existing two canonical tooling overlays from `69992a0769a896434028d2b16776423f31c6c7d0` only.

- 730 actual frontend files equal validation tree, mismatch 0.
- Original changed production file strict-full style: exit 0, one file, violations 0.
- Two changed production/control files pure TS AST parse: exit 0, diagnostics 0. Candidate imports/execution false.
- Full application typecheck: exit 2, 221 existing diagnostics; added 0/removed 0 normalized path/code/message diagnostics against actual source 3916. Application remains RED.
- `git diff --check`: exit 0 before source publication.
- Twelve cache/continuity/source-compare/authority/index/threshold/Write/factory/resolver/composition postimages exact vs base7cd.
- All runtime/test/list/discovery/collection/mount/browser/native/SDK/security/receipt/product qualification remains UNRUN/HOLD. No selector/rule/baseline/threshold/index/authority/receipt weakening or refresh.

## Owner handoff and entire assignment

Exact code source for independent re-review and #2245 owner consumption: `3c5e3f19b0f9cf1a6aafc6b308a76f43f9a03b0e`, minimal two-path delta from `7cd9e3806ffe7de7156950de31e2021ff34afe5b`. Original cache must eventually consume the SAME request's actual producer terminal on both success and rejection, keeping missing/unknown/rejected outcomes held. Its own P2 fix and consumer require exact parent-supplied commits/evidence, not a guessed sibling branch or whole-chain wait.

Native failure cleanup API, preview actual futures/source admission, upload/provider/File-loan cleanup, actual mount/tool/search/native restoration, full-session/factory and whole application qualification remain separate WIP.

| Owned issue | Acceptance status |
| --- | --- |
| #2246 | Open: observer source increment published; native semantic anchors/scroll pending |
| #2250 | Open: same-terminal continuity unchanged; full context/factory/lifetime/native gates pending |
| #2253 | Open: large-document/epoch/restoration controls UNRUN |
| #2256 | Open: provider/native/business/actual cleanup pending |
| #2280 | Open: migration/product prerequisites |
| #2282 | Open: actual Live/#2245 acceptance |
| #2284 | Open: same-work source-compare unchanged; mounted caller/host/sync/native/#2245 pending |
| #2286 | Open: preferences/#2280 acceptance |
| #2287 | Open: native Focus/Typewriter/prerequisites |
| #1809 | Tracking only: required child evidence incomplete |

`91 pending / 79 null / fullGeometryVerified=false` unchanged. No source-closed assertion before independent review, no chain completion, issue closure, merge, auto-merge, deploy, master push or cross-chain conflict-resolution stage.
