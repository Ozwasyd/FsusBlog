# Exact asset supplier continuation

Source capability: `f29e58795f777fd9d64dcdc6e3f1947f386b4309`.
Final source/test candidate: `e12d0416675075da0963a693aa335bda822631bd`.
Branch: `codex/issues-2124-2125-portable-assets-20261008`, draft PR #3979.
Fresh default fetched independently:
`8a95130ab5e391729d5606275d483edc678e9b5d`.

The exact supplier table at
`42ece11c821dd01e9f372b66e7822f0fd0fc3864` was read using the authorized
GitHub file reader, along with both current issue bodies/comments. Its asset
section confirms existing private reads, tickets, media checks and ledgers. The
four original private API/record sources are byte-identical on this branch and
the independently fetched default. Their hashes and new owned source/test hashes
are recorded in `source-binding.json`.

## Bounded actual source capability

`ArticleVaultAssetInputVerifier.VerifyCurrent` accepts these existing types:

```csharp
ArticleVaultOperationIdentity operation,
ArticleVaultSealedExecutionBundle bundle,
ArticleVaultDependencyPlan dependencies,
ArticleVaultPlanRequest currentRequest,
IReadOnlyList<VaultDependencyPlanInput> currentDependencies,
ClaimsPrincipal principal,
string trustedSiteIdentity,
string itemOperationIdentity,
Guid assetIdentity,
AssetRecord? record,
ReadOnlySpan<byte> assetBytes,
TimeProvider time,
CancellationToken cancellationToken
```

It returns only the original `ArticleVaultValidationResult`. The root caller
loads the actual bundle using the original `LoadSealedAsync`, supplies its
authenticated principal/trusted site and genuine current source/dependency
inputs, and invokes this method with original-supplier record/bytes. The method
reuses original bundle, operation, dependency, asset schema/hash/media verifiers.
It binds principal, exact item/AssetId, planned owner/content/media facts and
current source/rights; it rechecks current inputs, deadline and cancellation after
bytes. Asset owner remains independent of executing admin. It does not acquire
bytes, call private stores or issue tickets, create receipts, grant execution,
upload or materialize assets, or update a base. A caller record or successful
consistency check is not acquisition/authorization provenance.

The precise original method arguments, return fields, supplier bindings and
caller responsibilities are maintained in the current architecture document:
`docs/architecture/article-vault-dependencies.md`, section
`Original asset supplier binding`. Root-owned shared registration must add
`ArticleVaultAssetInputVerifierTests` and this new source to the existing
backend-unit coverage/closures. No shared project, matrix, lifecycle, coverage,
generated authority or ArticleWrite files were edited.

## Actual ordinary verification

The isolated composition uses the already documented original prerequisites;
it does not claim whole fresh-default or sibling acceptance. All commands below
used `source /workspace/.setup/activate.sh`.

```sh
dotnet build src/backend/FsusBlog.Server.csproj --no-restore -v:q
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore \
  --filter 'FullyQualifiedName~PortableDependencyManifestTests|FullyQualifiedName~ArticleVaultAssetValidationTests|FullyQualifiedName~ArticleVaultCommittedUploadObserverTests|FullyQualifiedName~UploadAssetObservationTests|FullyQualifiedName~ArticleVaultAssetStagingAdapterTests|FullyQualifiedName~ArticleVaultAssetInputVerifierTests' \
  --logger 'trx;LogFileName=asset-input-product.trx' \
  --results-directory /tmp/issues-2124-2125/results -v:q
```

Backend build exit 0, 0 errors; existing warnings remain. Full ordinary regression
at source/test `176c1d8f00406ef1e272ce6adf1324016c6e5fad`, composition
`36c65405736c75801c879b573c16946a5cb58360`: **220 passed, 0 failed, 0 skipped**.
Counts: portable manifest 32, asset validation 42, upload observer 20, staging 55,
new input verification 58, original real isolated PostgreSQL/native upload 13.

The new test's `Assert.Single` predicate was then expressed with the equivalent
original xUnit overload, removing its new xUnit2031 warning. No refusal/assertion
condition changed. Final affected ordinary tests ran on source/test
`e12d0416675075da0963a693aa335bda822631bd`, composition
`a50096cd362ad116925d54a24fb3825ca8483edf`:

```sh
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore \
  --filter 'FullyQualifiedName~ArticleVaultAssetInputVerifierTests|FullyQualifiedName~ArticleVaultAssetStagingAdapterTests' \
  --logger 'trx;LogFileName=asset-input-final-product.trx' \
  --results-directory /tmp/issues-2124-2125/results -v:q
```

Exit 0: **113 passed, 0 failed, 0 skipped** (58 input plus all original 55 staging
controls). Final test output has no warning for the new input test file. Both
actual TRX/log pairs are retained. Synthetic fixture services are asserted never
invoked by the new consistency verifier; these controls do not establish genuine
asset acquisition, ledger rights, native paths or materialization.

Applicable commands also passed:

```sh
node tools/governance/check-article-vault-dependency-boundary.mjs
node --test tests/tools/article-vault-dependency-boundary.test.mjs
node tools/dotnet/check-csharp-style.mjs \
  --file src/backend/Services/ArticleVault/Assets/ArticleVaultAssetInputVerifier.cs \
  --file tests/backend/Unit/ArticleVaultAssetInputVerifierTests.cs \
  --file tests/backend/Unit/ArticleVaultAssetStagingAdapterTests.cs
PATH="/tmp/issues-2124-2125/style-tools/node_modules/.bin:$PATH" \
  node tools/style/check-native-tooling-style.mjs \
  --file docs/architecture/article-vault-dependencies.md --require-tools
node tools/governance/check-change-contract.mjs \
  --range 6d50f8e9e665058bf994e1735be3ea946e0b8010..HEAD
git diff --check
```

Node controls 8/8, 0 skip; final C# style 3 files/0 violations; current Markdown
style 1 file/0 violations. Read-only source review found no substantive defect.
No independent QA, held audit, permission change or package publication occurred.

## Exact remaining supplier result

Original #1779/#2258 must provide its actual method/source and genuine result
bound to the original operation/plan/group/item/article/AssetId, selected source
revision, owner and current required/granted rights. Existing private handles
lack owner/dimensions/revision/rights/ledger fields; original AssetRecord provides
owner/dimensions but lacks server revision/version/reference ledger facts.
Existing committed upload observation supplies original version/reference facts
but not a Vault rights grant, intended-AssetId replay or explicit reuse receipt.
Ticket subject/purpose and plain reads cannot be renamed as Vault operation
admission. Display URLs, timestamps and caller-created seals are not substitutes.

The current document names every required argument/return binding and exact
existing caller. Original accepted execution/asset owners must additionally bind
the accepted operation's resulting reference facts before recovery can distinguish
expected writes from later drift. #1865 supplies actual portable asset path
mapping; #1910/#2128 supply asset-specific conditional native materialization,
readback/recovery and verified receipt/base commit. Article-source-only mutation
preparation is not an asset-path grant. No replacement supplier interface,
receipt, store, policy or production mock is introduced.

Status: #2124 implemented WIP (unchanged); #2125 implemented WIP with additional
exact plan/byte input binding. Full accepted issues: 0. Root retains candidate
execution admission, shared registrations and final review/merge. No CI pass,
issue closure, runtime/platform acceptance or synced base is inferred.
