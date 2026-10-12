# Promise subclass/species observer P2: bounded source fix

Base `efec36c93f305b0f12f8398c6fd6b701a044bfee`; implemented `5812b9a19516ef7170eb2dbf376b78f6a6d3d132`; final checked-descriptor/lint repair and tested source `cbd7213c31dd9a189c3a5d80456a7efd110a65f8`. Minimal code/control net changes original articleFsusUiRenderProducer and existing control file only. Branch codex/chain-2246-preack-runtime-intake; draft https://github.com/Ozwasyd/FsusBlog/pull/4153.

Independent reviewer closed old fulfilled-value forwarding at 3c5, but identified a distinct P2: awaiting a species-produced Promise subclass can thenable-wrap it, call its then and create an ignored descendant. That descendant may reject while observer/completion fulfill. Prior static checks did not qualify that runtime boundary.

## Actual boundary correction

The original helper captures the native Promise constructor/prototype and actual then/species descriptors. It observes only an exact native-prototype Promise with a data constructor matching that captured constructor and its unchanged default species getter. Constructor/species accessors and custom species are not invoked. Unsupported subclass/cross-realm/thenable futures remain held as the original unknown cause; there is no thenable wrapper or attempted descendant production for them.

The actual native then method is invoked through its checked descriptor without casts/unbound-method/config exceptions. Explicit fulfillment/rejection handlers return undefined. Actual derived/completion futures remain in the same per-request custody. Await is reached only for the exact native derivative from that checked native/default-species operation, rather than for an arbitrary species-produced subclass. Any synchronous guard/method/observer exception is retained; unknown terminal remains rejected.

This is a conservative refusal boundary, not a claim that an unsupported original future has been safely observed or cleaned. Its original producer must provide a genuine safe terminal capability before it can qualify cleanup. No wrapped settled promise, metadata admission, forced eviction, second cache/store/issuer/registry/native owner or native settlement proof is created. Current cache still does not consume producer terminal, so there is no demonstrated cache lease-loss claim.

## Source controls / limits

Existing second-getter replay capability is preserved but its assertions are strengthened: hostile species must be refused before invocation, with actual constructor/species capability and original cause held. A Promise-subclass-producing variant is added, verifying no subclass/ignored descendant is manufactured. The constructor-getter control now requires descriptor refusal rather than invoking its getter; all returned/throw/native/release/identity/same-work controls remain intact. Controls are UNRUN, not collected or imported. No runtime unhandled-rejection count is claimed.

Source gates bind cbd721:

- Canonical strict-full changed-production style exit0, one file, zero violations. Two earlier unbound-method failures retained in initial-style-failed.txt and second-style-failed.txt; source corrected without changing rules or baseline.
- Two-file pure TS AST parse exit0, diagnostics0, candidate execution false.
- Complete application alias typecheck exit2, 221 existing diagnostics; added0/removed0 normalized against actual 3c5. Whole application remains RED.
- Exact git archive of tested commit: 730 frontend files equal static candidate, mismatch0. Separate uncommitted useAdminArticleWrite body WIP is explicitly NOT part of this observer candidate.
- Existing official Node24.16.0, locked tooling, real public FsusUI6a73, canonical699 overlays unchanged.
- Runtime/test/list/discovery/collection/mount/native/SDK/security/receipt/product qualification all UNRUN/HOLD. No frozen threshold/index/authority/receipt refresh or weakening.

## Preserved independent Writer WIP and precise next contracts

Parent priority paused original restored-body work to deliver this minimum observer correction. Exact Writer working diff and blob are saved in /workspace/.tmp/chain2246-observer-subclass-p2/writer-body-adoption-wip.patch and writer-body-adoption-wip.json, with the source file still present/modified. It is NOT checked/accepted as part of cbd721.

Readonly supplied boundary inspection: Main Blog1b8cb055dfd92cb4ee3381e69d6f1dd06000032d and UI d60b94b5828962ddb3bd8b7a2d78f949fef4c599. No Main/frozen authority whole-file overwrite or consumption. Original17c genuine preparation/acquisition can select the real adapter before fixed effects. Existing attached-consumer handover is not exposed by that authority; native restore still requires real identity/epoch/revision and snapshot custody. Writer WIP attempts only first prepared owner bootstrap with original detail loader/source/setter guards, not general old-body/full-ref restoration.

Required original-owner contracts remain: Document actual existing-consumer handover; Main/Rail mount-before-loader startup input and genuine original publication; native owner cross-revision/body acceptance and full-ref atomic replacement with failure retention; real multi-draft/source/base/server revision custody. Do not substitute metadata/journal content/partial ack. No general restored-body adoption completion or native/full-ref readiness is claimed.

## Entire assignment WIP

#2246 native anchors/scroll; #2250 full context/factory/lifetime/restored-body; #2253 large-document/epoch/restoration execution; #2256 provider/native/business/cleanup; #2280 migration/product prerequisites; #2282 Live/#2245 acceptance; #2284 mounted caller/host/sync/native/#2245; #2286 preferences/#2280; #2287 native Focus/Typewriter all remain OPEN/unaccepted. #1809 tracking child evidence remains incomplete. Current #2245 source terminal consumer/null-unknown fix, preview/upload actual futures and native cleanup remain precise external gates.

No source-closed assertion before independent re-review, chain completion, issue closure, merge, auto-merge, deployment, master push or conflict-resolution phase. 91pending/79null/fullGeometryVerified=false unchanged.
