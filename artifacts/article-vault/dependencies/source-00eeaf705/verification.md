# Dependency source verification

This records diagnostic source checks, not a runtime receipt, accepted issue,
package qualification, native device result or replacement test authority.

- Published source: `00eeaf705dcc03a5412b36002df0b166e7442f3a`.
- Branch: `codex/issues-2124-2125-portable-assets-20261008`; draft PR #3979.
- Independent fresh default: `0e9dd5751bdd584204fd149bdb1526b97ff682a6`.
- Exact composed verification source: `cfc2c7a771ad978743314f0bf0b2672ba26f0d82`.
- Its prerequisite imports are byte-exact `src/migration/FsusBlog.Migration.csproj`
  and `src/migration/packages.lock.json` from
  `e3553bfb1ade96bb6ac6609bf92efc42de3913be`, and `tests/backend/packages.lock.json`
  from `93e9b8c25056abb50f264db6dbad69082e85b551`.
- [Source binding](source-binding.json) proves all 12 issue-owned source/test/doc
  files are byte-identical between the published and composed candidates.

## Actual checks

Commands used `source /workspace/.setup/activate.sh` for the configured SDK.

| Command / scope | Actual result |
| --- | --- |
| `dotnet build src/shared/FsusBlog.Shared.csproj --no-restore -v:q` | Build succeeds; inherited analyzer warnings remain. |
| `dotnet format whitespace src/shared/FsusBlog.Shared.csproj --no-restore --include` followed by the four owned dependency C# paths | Succeeds; only owned files selected. |
| `dotnet format whitespace tests/backend/FsusBlog.Server.Tests.csproj --no-restore --verify-no-changes --include tests/backend/Unit/PortableDependencyManifestTests.cs tests/backend/Unit/ArticleVaultAssetValidationTests.cs` | Selected new tests format clean. |
| `dotnet test /tmp/issues-2124-2125/focused/DependencyFocused.csproj --no-restore --logger 'trx;LogFileName=dependency-focused.trx' --results-directory /tmp/issues-2124-2125/results -v:q` | **32 passed, 0 failed, 0 skipped**; original new portable test source compiled against actual Shared project. Diagnostic project only. |
| `dotnet test /tmp/issues-2124-2125/assets-current/AssetCurrent.csproj --no-restore --logger 'trx;LogFileName=assets-current.trx' --results-directory /tmp/issues-2124-2125/results -v:q` | **42 passed, 0 failed, 0 skipped**; original new asset test source uses the actual full backend DLL compiled from the composed candidate. Diagnostic project only. |
| `node tools/governance/check-article-vault-dependency-boundary.mjs` | Succeeds on the actual owned adapters. |
| `node --test tests/tools/article-vault-dependency-boundary.test.mjs` | **8 passed, 0 skipped**. Static controls do not qualify runtime execution. |
| `node tools/style/check-native-tooling-style.mjs --file docs/architecture/article-vault-dependencies.md --file src/shared/Contracts/ArticleVault/Dependencies/portable-dependency-manifest.schema.json --require-tools` with actual `markdownlint-cli2@0.23.1` installed in task-local `/tmp` | Exit 0; selected=2, checked=2, violations=0. Initial missing-tool failure was corrected by installing the exact tool, without changing repository policy. |
| Offline Draft 2020-12 JSON Schema validation using the three actual local schema documents | Schema valid; actual production serializer output accepted; unknown authority field rejected. No network schema resolver. |
| `node tools/docs/check-authoritative-development-docs.mjs` | Exit 0. |
| `node tools/governance/check-change-contract.mjs --range 53da546cc8ab9fd8603067395d988b7ddb650394..HEAD` | Exit 0 on the three source commits. |
| `git diff --check` | Exit 0. |

## Preserved first failures

The original uncomposed backend test command fails `NU1004` because its consumer
lock omits the actual Server AngleSharp dependency. No shared lock is changed on
the published source branch.

In the exact isolated composed candidate:

```sh
dotnet restore tests/backend/FsusBlog.Server.Tests.csproj --locked-mode -v:q
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter 'FullyQualifiedName~PortableDependencyManifestTests|FullyQualifiedName~ArticleVaultAssetValidationTests' --logger 'trx;LogFileName=canonical-dependencies.trx' --results-directory /tmp/issues-2124-2125/canonical-results -v:q
```

Locked restore exits **0**, with audit unchanged and no lock regeneration. The
original test-project compilation exits **1**, before tests execute, at the four
existing `CS0182` attributes in `LifecycleHostedBootstrapServiceTests.cs:23–26`.
[Complete compilation output](canonical-compilation.log) preserves the original
warnings and failures. The affected file belongs to original source integration
`d56c2f04b2bbdfdea18178980703bb786f2ec08c` (#3662/#1761 and its children), not this
subchain; it is unchanged here. Diagnostic xUnit projects do not override that
canonical failure.

`node tools/docs/generate-document-lifecycle.mjs --check` exits **1** for the new
unregistered document and stale inventory. `node tools/check-test-lifecycle.mjs`
with the configured SDK exits **1** because the original test project's Debug
build context is missing. Shared registration remains original #3582 owned and
is proposed precisely in the [integration request](integration-request.md).

The original complete matrix, remote CI, live ledger/store operations, package
export/import roundtrip, platform/device tests and publication/security terminal
acceptance were not run or claimed. The full media decoder remains outside the
existing header/dimension inspector's proof.

## Issue status and next capability

- #2124: **implemented WIP**. Closed manifest/schema, semantic digests, current
  scope/rights/edge/source checks, canonical bounded graph ordering and immutable
  sync-plan extension exist. Fresh pull observations are bound rather than the
  older stored server coordinate. Canonical package mapping/extension wiring,
  shared registration and full owner acceptance remain outstanding.
- #2125: **implemented WIP; pull/upload/materialization blocked**. Actual
  byte/metadata validation and digest-based three-way diagnostics exist. Required
  canonical authorized AssetId read, intended-id idempotent upload, explicit reuse
  and ledger/reference/rights/revision receipts, stable snapshot/materialization
  and recovery handoffs are absent. No production substitute, direct storage/DB,
  source rewrite or writer was introduced.
- **Accepted: none.** Both issues remain open; root owns final integration,
  independent acceptance and merge.
