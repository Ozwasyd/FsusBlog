# Original Writer client-revision private fence: repaired source WIP

Source `6195837a61c4b4098a879cb151f4f3da45f996f5` repairs the parent's independent P2 on original8fa/ed95, same branch and draft PR4233. Repaired head needs independent review. All runtime and source controls remain HOLD/UNRUN; no SourceClosed or full-host readiness claim.

The actual original `saveDraftNow()` can synchronously assign ordinary `activeRecoveryClientRevision` when it was null, before its asynchronous journal/server save completes. That assignment triggers no reactive form/context/version watcher. Previously the candidate could still pass its private generation/mount predicate and replace the committed slot with the old client revision.

The minimal repair compares `candidate.custody.owner.clientRevision === activeRecoveryClientRevision` in the SAME private predicate. This covers every assignment site without setters, a new state owner or a callback. `hasCustody` becomes false immediately; publish refuses and cancels only the failed candidate before touching committed custody. Publish still invokes no external reader, native/Registry/journal operation, allocation or reactive write. Failed candidate cannot be recommitted. Current version mismatch is not relabeled as an unchanged/valid old snapshot.

## Ordinary state audit

The actual production AST records all six assignments to `activeRecoveryClientRevision` in `source-parse.json`: server-save confirmation clear, synchronous save allocation, recovery-scope clear, explicit restoration assignment, document reset clear, and actual content watcher assignment. All are covered by the exact-current scalar comparison; no source-only setter wrapper or fake revision is introduced.

Other ref-affecting ordinary Writer state was traced against the original `fullDraftInfo`, `readFullDraftOwner`, semantic identity and pure predicate:

| Field/fact | Original fence or applicability |
| --- | --- |
| active/componentAttached | Explicit private predicate scalars |
| originalMountedRuntime/originalMountedEditor | Exact original private pointer comparisons; release clears them synchronously |
| editorRuntimeBinding | Fresh original owner compares the exact binding; its release writes binding/runtime/editor pointers together without an intervening callback |
| fullDraftGeneration/committed/pending slots | Exact private generation and object comparisons |
| fullDraftReleased/fullDraftPrincipalRetired/capture/restore flags | Explicit private predicate; actual scope/principal watchers retain their original semantics |
| documentPrincipalIdentityId/site/user | Original immutable constants plus permanent reactive-principal retirement; Document context subscription fences version/epoch changes |
| baseRevisionId/serverRevision/revisionNo/draftKey/full form/pause | Original reactive refs/computed inputs with synchronous semantic/pause/context invalidation; no additional ordinary version input found |
| sequence, save timers/inflight tokens, source hashes/recovery bookkeeping | Not fullDraftInfo version fields; do not qualify journal/renderer/full-host custody, which remains missing/HOLD |

No independent native/Document/Main/journal producer is modified by this repair. The original body WIP41b4 stays separate. The genuine Document26 intake remains unchanged.

## Counterexample and exact static evidence

One additional control in the COMPLETE original regression entry constructs the real retained Writer with a nonempty title and null client revision, captures/validates a genuine candidate, calls original `saveDraftNow()`, and without an await checks private refusal. A throwing mounted-reader hook guards against accidental external reads during publish. Original explicit release of the old draft locator then proves the committed slot was not replaced; it does not fresh-inspect or certify an old version after the save. This new control plus the existing12 and all upstream controls are UNRUN.

Original application type entry exits2,221 existing complete headline diagnostics, added0/removed0, ownedWriter0 vs originaled95. Exact730 frontend source bytes match619, and AST Writer/control parse exits0. Original strict-full style exits0 with **files=1, eslint=1, violations=0**; it checks the production Writer only. The control file receives AST parsing, not a lint pass. The prior README/PR two-file lint assertion was wrong and is corrected; raw original logs are retained unchanged. Canonical configs/thresholds/qualification and actual local UI6a73 remain unchanged.

`writer-only.patch` is the current complete Writer offer against original6c75. It checks0 against the exact supplied Mainbbed/fce source; no Main file is applied or overwritten. Patch normalization changes only space-only blank context lines in the tracked artifact. Raw current commands, exit codes, source blobs and run identity `/workspace/.tmp/chain2246-writer-client-revision-p2` are preserved here. No runtime/test/list/discovery/collection/import/mount/native/SDK/security/receipt/full-ref/restore/eviction/product gate ran.

Main's genuine native/journal/renderer complete join remains refused. All nine execution issues remain OPEN/unaccepted; tracking #1809 remains incomplete. No merge, closure, deployment, master push or cross-chain conflict resolution.
