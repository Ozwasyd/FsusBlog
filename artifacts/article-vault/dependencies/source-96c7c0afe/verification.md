# Ordinary product integration evidence

Source/test candidate: `96c7c0afefe8790ec88acdfa3131ca3be7f84d3a`.
Exact isolated composition: `08f04ba6875d523a680a1d5e03190bbdb092bb35`.
Fresh default independently observed:
`aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`.
The composition uses the earlier independently fetched default
`0e9dd5751bdd584204fd149bdb1526b97ff682a6` plus actual canonical prerequisite
and task source commits; it is not a claim that the whole latest default or every
sibling branch has been accepted. `source-binding.json` verifies identical owned
source/test/document bytes in the candidate and frozen composition.

## Commands and results

Commands use `source /workspace/.setup/activate.sh` (SDK 10.0.401 and Node 24).
The ordinary original backend project ran from the clean frozen composition:

```sh
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore \
  --filter 'FullyQualifiedName~PortableDependencyManifestTests|FullyQualifiedName~ArticleVaultAssetValidationTests|FullyQualifiedName~ArticleVaultCommittedUploadObserverTests|FullyQualifiedName~UploadAssetObservationTests|FullyQualifiedName~ArticleVaultAssetStagingAdapterTests' \
  --logger 'trx;LogFileName=asset-current-product-final.trx' \
  --results-directory /tmp/issues-2124-2125/results -v:q
```

Exit 0: **162 passed, 0 failed, 0 skipped**. Exact result is retained in
`ordinary-product-final.trx`; compiler/test output is retained in
`ordinary-product-final.log`. The project compiled with its existing warnings.

| Class | Passed | Evidence scope |
| --- | ---: | --- |
| PortableDependencyManifestTests | 32 | Ordinary closed graph/planner unit tests |
| ArticleVaultAssetValidationTests | 42 | Original asset model/media validation unit tests |
| ArticleVaultCommittedUploadObserverTests | 20 | Adapter controls with synthetic file service observations |
| ArticleVaultAssetStagingAdapterTests | 55 | New exact plan/item preparation, drift, refusal and cancellation controls |
| UploadAssetObservationTests | 13 | Original real isolated PostgreSQL/native committed upload observation tests |

Synthetic stage/execution store adapters are unit controls only. They do not
qualify real asset-stage persistence, intended-AssetId upload replay, accepted
asset reference recovery, portable paths or native materialization. The real
upload tests establish only their original existing ledger/byte observation
capability. No independent graph/occurrence QA, diagnostic project, harness or
denied acceptance run was replayed in this continuation.

Other actual commands/results:

```sh
node tools/governance/check-article-vault-dependency-boundary.mjs
node --test tests/tools/article-vault-dependency-boundary.test.mjs
node tools/dotnet/check-csharp-style.mjs \
  --file src/backend/Services/ArticleVault/Assets/ArticleVaultAssetStagingAdapter.cs \
  --file tests/backend/Unit/ArticleVaultAssetStagingAdapterTests.cs
PATH="/tmp/issues-2124-2125/style-tools/node_modules/.bin:$PATH" \
  node tools/style/check-native-tooling-style.mjs \
  --file docs/architecture/article-vault-dependencies.md --require-tools
node tools/governance/check-change-contract.mjs \
  --range cb648d39316cf5a2facc53e61036d59b8e202438..HEAD
git diff --check
```

All exit 0. Node unit tests: 8/8, 0 skip. C# final changed files: 2 checked,
0 violations; the retained earlier 7-file check also passed all four owned graph
modules, both new staging modules and the staging test. The final difference is
documentation/private helper visibility only. Current Markdown lint: 1 checked,
0 violations. The change checker passed the current continuation's commit range,
not the entire old historical branch. Output hashes are in `source-binding.json`.

## Resolved failures and limits

The first 55 staging cases failed during fixture setup because server identity
`42` violates the existing minimum identity length. After correction to `042`,
the second run still failed setup because the manifest reference omitted the
actual `article:` prefix. The third run used the exact original root reference
contract and passed 55/55. Both failure TRX files and the corrected pass are
retained; no production rule, refusal assertion or threshold was weakened.
The final 162-case run includes the corrected private fixture at its committed
SHA.

Original CS0182 and other compiler fixture issues were resolved using unchanged
actual `f53b6b79f8cf051bd190cad2e49a57ea4a1cc1bd` source in the isolated
composition. No shared fixture edits were published on this task branch; these
old errors are not a current blocker. An initial accepted-source compile attempt
missed copying its actual preflight file; the exact commit composition contains
all three unchanged files and the final original project compiled successfully.

The command channel briefly returned `exec-server transport disconnected`.
It was subsequently confirmed in the same session at `2026-10-08 09:41:06 UTC`
with successful `/workspace/FsusBlog` pwd and clean git-status commands. The
source push had already returned success before that checkpoint and was not
duplicated. Final session 2323 returned exit 0. No cause is inferred from these
observations.

Source review rejected a proposed uncommitted materialization wrapper because
normal acceptance changes the sealed prewrite server coordinate and reference
ledger. Both wrapper files were removed before commit. The pre-execution stage
continues rejecting stale/drifted facts; only original owners can bind the
accepted asset result. Their exact required capabilities and shared registration
diffs are in `integration-request.md`.

Status: #2124 implemented WIP; #2125 implemented WIP; full accepted issues: 0.
No remote CI, complete package/native/runtime/platform qualification, merge,
closure, deployment or package publication is claimed. The original coordinator
retains shared registrations, independent acceptance and final review/merge.
