# Integration handoff for original #3582

Source/test candidate: `96c7c0afefe8790ec88acdfa3131ca3be7f84d3a` on
`codex/issues-2124-2125-portable-assets-20261008`, draft PR #3979.
Fresh default observed independently:
`aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`.
The source is WIP for #2124/#2125; neither issue has full acceptance.

New narrow commits since the previous evidence candidate:

| Commit | Capability |
| --- | --- |
| `2decbd17f46f0cfa22e39cd6d72a0c372b60ce8d` | Canonical plural flags name `VaultDependencyRights`; wire names/values preserved |
| `611855165da3dcda988af15edee0ae2aa6c02740` | Unchanged actual operation contracts/verifier from `9cd6ae50b233eee35f291c9690d316bbfee37941` |
| `ba532e37017a7b1b71a233ceda0d42a46759b248` | Plan/item-bound committed upload observation preparation and revalidation |
| `2f284c078318284905272e311875ce2e045c052f` | Unchanged actual source instruction/preflight/accepted-source reader from the same original head |
| `ab5a3f5509d73fec7eb761e7c5df4ccf7b5a7541` | Document strict pre-execution stage boundary and missing accepted asset binding |
| `96c7c0afefe8790ec88acdfa3131ca3be7f84d3a` | Ordinary original-project staging tests: 55 expanded cases |

Consume original canonical capabilities once in the integration tree. The source
imports here are selective unchanged bytes, not ownership of operation or
accepted-source authorities. For committed upload observation, consume original
`982430c1c696e51715e1fb9587acbc2f61ec8902`; the historical local cherry-pick
`8b1679519ee8881763579eb752b68426b848f354` retains an attribution-after-Refs
footer issue. This turn's commit range passes the original change checker; the
published historical range has not been rewritten.

## Exact shared edits requested

The previous `source-00eeaf705/integration-request.md` resource, document,
matrix/lifecycle/coverage registration instructions remain integration-owned.
Add `ArticleVaultCommittedUploadObserverTests` and
`ArticleVaultAssetStagingAdapterTests` to those original backend-unit closures.
The new backend source files are included by the existing SDK project glob; no
second project or test runner is needed.

The sibling occurrence source `d17c22432d475325ff7a9a3fafacf02d1cc15840` still
uses the singular symbol in two tests. Its owner/root must apply this exact
replacement at lines 300/301 of `ArticleVaultBlockLinkRefactorTests.cs` and
184/185 of `ArticleVaultFrozenEmbedAdmissionTests.cs`:

```diff
-            VaultDependencyRight.Read | VaultDependencyRight.Reference,
-            VaultDependencyRight.Read | VaultDependencyRight.Reference, Digest, Digest, Digest);
+            VaultDependencyRights.Read | VaultDependencyRights.Reference,
+            VaultDependencyRights.Read | VaultDependencyRights.Reference, Digest, Digest, Digest);
```

No compatibility alias or concurrent edit was made to those files. Their
production link/embed source does not reference this flags symbol. The upstream
occurrence fixes were read as source; independent occurrence QA was not replayed.

Original backend compiler fixture prerequisites are resolved by actual
`f53b6b79f8cf051bd190cad2e49a57ea4a1cc1bd` bytes, consumed only in the isolated
composition as `14b7422ec2d50a62bdba5fc3c45ac98ce071abf1` and
`1ebc154e4f8ca494862addf3f9afb9496999bf48`. These are not changes to shared
fixtures in this task branch. Old CS0182 failures are historical, not a remaining
unresolved capability blocker.

## Exact missing original-owner capabilities

- #1779/#2258: intended-AssetId upload initialization bound to exact global
  operation, item, plan and content, with original-store replay/idempotency.
  Existing `InitUploadSessionAsync` allocates a new identity per call; observing
  a committed upload is read-only and does not supply that initializer.
- #1779: authorized AssetId bytes plus ledger/version snapshot and explicit reuse
  result. Current `IAssetStore` only exposes deletion; private ticket/storage
  internals cannot act as a general Vault asset grant.
- #2128 execution owner and #1779/#2258 asset owner: read and validate the exact
  accepted operation's resulting asset reference facts, then compare them with
  original current `ObserveCommittedUploadAsync` facts. Successful article writes
  can legitimately change server revision and reference ledger; old prewrite
  facts cannot be supplied as fresh, and arbitrary deltas cannot be allowed.
- #1865 owner #3560: actual package manifest extension and portable AssetId path
  projection bytes/API. The finite typedmetadata head
  `f4600360c7d2847f048ebc5465baae052aa7efe8` is not this mapper.
- #1910/#2128: asset-specific native conditional materialization, readback,
  recovery and verified receipt/base commit. Native source mutation preparation
  `5e7fd98bdefc8cbd5c0a405accc383da917dfa3a` admits article source projections,
  not asset paths, and cannot perform final replacement/base commit.

The new staging adapter prepares only an existing committed upload observation
before execution. It neither persists a stage nor starts an upload or materializes
bytes. A proposed accepted-materialization wrapper was removed before commit
because normal accepted server/ledger transitions cannot pass a prewrite
revalidation. No substitute receipt, store, grant or production mock was added.
All capability booleans remain false. Integration retains actual cancellation,
rollback/recovery obligations and fail-closed drift rejection.

The coordinator owns issue/PR content updates and final review/merge. This turn
only pushed isolated source commits; no remote CI result, issue closure, merge,
package publication or platform/runtime qualification is claimed.
