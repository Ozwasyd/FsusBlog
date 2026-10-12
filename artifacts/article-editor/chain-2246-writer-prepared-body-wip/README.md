# Writer prepared-body prototype: HANDOFF WIP, not production readiness

## Exact artifact identity

Current draft https://github.com/Ozwasyd/FsusBlog/pull/4153, branch codex/chain-2246-preack-runtime-intake. Artifact-only preservation; production source is NOT committed/applied by this handoff. Observer code cbd7213c31dd9a189c3a5d80456a7efd110a65f8 remains independent.

- Patch baseline commit `32f81d94d728599bfa1e82bf4cbbc1095bd65b8a`, Writer preimage blob `6c75ec510b9b19dda80eea292db6f6d7a7a092bf`.
- Writer candidate postimage blob `41b4e7ab0f4d9a89afc72dd9b90bf144fde2a8e1`.
- Single owned production path: src/frontend/src/composables/useAdminArticleWrite.ts. Exact net patch and SHA256/size in patch-identity.json. Reverse apply check0; only space-only blank context lines normalized for tracked artifact whitespace.
- Working source file remains modified separately. Apply only against matching preimage; do not whole-file overwrite guarded Main Writer or resolve cross-chain conflicts here.
- Readonly Main interface: Blog `1b8cb055dfd92cb4ee3381e69d6f1dd06000032d`, Writer blob `fce247d0084a60a524025887276207bd96440fe5`; UI `d60b94b5828962ddb3bd8b7a2d78f949fef4c599`. Their actual source was read, not silently merged. Main4-line mounted draft-owner getter must remain preserved by its owner on eventual exact composition.

## Independently implemented prototype parts

An optional ArticleWriterPreparedStartup takes an actual original handle plus genuine branded preparation and acquires the 17c authority binding before fixed document-dependent adapters/effects. It refuses scope/identity/version mismatch and accepts only source revision0/draft revisionnull preparation; it does not rebuild an adapter or issue identities. The original first consumer is attached before loaders start. Existing-consumer replacement is refused by original17c, rather than inventing another owner.

Original detail loader reads the actual backend ArticleDetailResponse and pins binding/principal/site/epoch/source/draft/form identity, registry revision/membership, pause/conflict, client revision and current base/server/revision-no state across await and each form setter. The source must match the original prepared context's genuine digest. It applies full fields through original applyDraftToForm with expected partial-form admission. Expected revision-no is updated before its setter, followed by the SAME full guard; no parallel client revision or newer watcher edit is absorbed.

Recovery/conflict pause is not cleared by this loader. Prepared init does not invent a multi-draft server key, change document/native revisions or clear original recovery state. Existing full-form capture/restore shares its original guarded form helper, with its same-owner admission retained. No body/history store is added; temporary DTO/expected form values live only in the actual call.

Native binding is gated on body-source loading. Final prepared adoption attempts an actual public no-change native transaction and checks real returned source/identity/epoch/revision against that same form/context. The actual original transaction port and session are references to the SAME mounted object, not typed methods fabricated on Main's session-only interface. It replaces no snapshot/full refs. Failed/stale/throwing flows retain refusal/error and do not pretend rollback.

**Limits:** this is only first prepared-owner current-detail or empty-draft bootstrap. It cannot restore an arbitrary old full-form/reference set, recover an existing attached consumer into a different Writer, move across native revisions/owners, hydrate a disposed native transaction/history owner, or prove snapshot cleanup. The read-only preparedBodyLoaded signal is only source bootstrap, not native/full-ref/product ready. Applying this prototype to production before genuine owner contracts/review is not authorized by static results.

## Minimum real original-owner contract gaps

1. Document original author `01a12cf5-cd0e-753a-b7f0-81f100373027`: actual attached-consumer handover/borrow, preserving the original consumer/factory identity and invalidation/cleanup custody. Refuse another consumer/issuer/store. Principal/site/current membership/identity/epoch/revision checks before and after readers. Return genuine binding/consumer, not a lookalike context.
2. Main/Rail/Layout: pass genuine preparation/handle (or that actual handover) BEFORE useAdminArticleWrite constructs fixed adapters/effects; defer actual native mount until source bootstrap is admitted. Preserve Main's original mounted draft owner getter and guard final association reads. Need exact source/API commit and startup caller identity from its owner.
3. Real body-loader custody: admission must bind the actual chosen detail/server-draft/full-form source, principal/site, article/draft/document identity, epoch, source/draft/base/server/client revision and cancelled/paused/conflict state. Equal body digest is not enough for old full-form/base/server metadata restoration. Existing create draftKey is shared/legacy; no opaque multi-draft mapping is supplied. Do not treat journal-content or plain metadata as body authority.
4. Native owner/full-ref original author: actual cross-body/revision/native owner acceptance plus atomic refs replacement, original native history/render/provider futures, failure/interrupt/repeat custody and truthful publication. Current restoreSnapshot accepts only same retained snapshot/identity/epoch/revision. No metadata rewrite, fake digest/revision/settlement or partial acknowledgement fills this gap.

These are issue-level/source/API requests; do not wait for whole chains and do not edit those original owner files locally. Constructor/new-body publication remains WIP until they supply exact interfaces/evidence.

## Actual source checks of this WIP blob

The original environment is available; this is not an admission-as-recovery claim. Current working blob 41b4... was copied into static candidate; observer cb... source remained unchanged. Original tooling/real local UI6a73, official Node24.16.0 and canonical699 overlays only.

- Strict production style exit0, one file, violations0.
- Pure TS AST parse exit0, diagnostics0; candidate/test modules NOT executed.
- Whole application alias typecheck exit2, existing221 diagnostics, added0/removed0 normalized relative to observer candidate. Whole application remains RED.
- Initial attempts had a real native-port missing property error (222) and then a too-narrow object identity type produced six errors (227); corresponding compiler/style negatives preserved. Repair used the genuine original port plus overlapping public session capability type, without casts/config/rule/baseline weakening.
- Runtime/test/list/discovery/collection/mount/native/SDK/security/receipt/full-ref/product acceptance UNRUN/HOLD. No frozen authority/index/threshold/matrix/receipt refresh. No full readiness or source-closed declaration is implied by type/style.

## Entire assignment

#2246 native anchors/scroll; #2250 full context/lifetime/restored-body; #2253 large-document/epoch/restoration execution; #2256 provider/native/business/cleanup; #2280 migration/product; #2282 Live/#2245; #2284 mounted host/sync/native/#2245; #2286 preferences/#2280; #2287 native Focus/Typewriter all remain OPEN/unaccepted. #1809 tracking child evidence incomplete. Observer still under independent review; source-only gates separate from all required runtime and actual native/full-ref acceptance.

No production application of this patch in published tree, no issue closure, merge, auto-merge, deploy, master push or cross-chain conflict resolution. 91pending/79null/fullGeometryVerified=false unchanged.
